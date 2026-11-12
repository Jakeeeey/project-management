"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, Eye, RotateCcw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { flattenVisible, pruneForest, type TreeNode } from "./utils/tree";

import { AssigneeDialog } from "./components/AssigneeDialog";
import { SubtaskCreateDialog } from "./components/SubtaskCreateDialog";
import { TaskDetailSheet } from "./components/TaskDetailSheet";
import { TaskFormDialog, type TaskBreadcrumb } from "./components/TaskFormDialog";
import { TaskListSwitcher } from "./components/TaskListSwitcher";
import { DEFAULT_TASK_PAGE_SIZE, TaskPagination } from "./components/TaskPagination";
import { TaskTree } from "./components/TaskTree";
import { SortableTaskRow } from "./components/tree-dnd/SortableTaskRow";
import { TreeDndProvider } from "./components/tree-dnd/TreeDndProvider";
import { TaskTagsDialog } from "./components/TaskTagsDialog";
import { TasksHeaderActions } from "./components/TasksHeaderActions";
import { TasksToolbar } from "./components/TasksToolbar";
import {
    anyGroupActive,
    cloneGroupsForApply,
    failsExcludingGroup,
    rowMatchesFilter,
    type FilterGroup,
    type SavedTaskFilter,
} from "./components/task-filter";
import { knownGroups } from "./components/task-filter-state";
import { TasksViewTabs } from "./components/TasksViewTabs";
import { BoardView } from "./components/views/BoardView";
import { CalendarView } from "./components/views/CalendarView";
import { DashboardView } from "./components/views/DashboardView";
import { GanttView } from "./components/views/GanttView";
import { ProgressView } from "./components/views/ProgressView";
import { TeamView } from "./components/views/TeamView";
import type { CellEditRequest } from "./components/TaskCellEditor";
import type { TaskRowPatch, TaskRowProps, TaskRowView } from "./components/TaskRow";
import type { TaskViewProps, TasksViewId } from "./types/task-view";
import { useAssignees } from "./hooks/useAssignees";
import { useSavedTaskFilters } from "./hooks/useSavedTaskFilters";
import {
    useTasks,
    type TaskCatalogOption,
    type TaskCatalogRef,
    type TaskCatalogs,
    type TaskListItem,
} from "./hooks/useTasks";
import { useTaskMutations } from "./hooks/useTaskMutations";
import { useTaskFilterState } from "./hooks/useTaskFilterState";
import { useTaskLists } from "./hooks/useTaskLists";
import { useTaskTree, type TaskTreeRow } from "./hooks/useTaskTree";
import { useTags } from "./hooks/useTags";
import type { CreateTaskInput, MoveTaskInput, UpdateTaskInput } from "./types/pm-task.schema";

/**
 * The Tasks client orchestrator.
 *
 * It owns the page's interaction state — the search box, the filter-clause array, the root page
 * number, the page size and the background-refresh flag — and composes the hooks that carry the
 * data:
 * `useTasks` (rows, catalogs, capabilities), `useAssignees` (the member directory that names the
 * assignees) and `useTaskTree` (the assembled forest plus expand/collapse state).
 *
 * Responsibilities that deliberately live elsewhere:
 * - **Dialogs** are `TaskFormDialog` (create and edit), `SubtaskCreateDialog` (create under a parent)
 *   and `TaskDetailSheet` (read view with the edit / add-sub-task / delete actions). This module owns
 *   only their open state and the callbacks they call, so the toolbar's `onCreateTask` contract stays
 *   a plain "open the create dialog".
 *
 * Filtering follows the pinned semantics: a matching row brings its ENTIRE subtree (searching a
 * parent still shows every child), a non-matching ancestor of a match stays visible with only the
 * matching branches beneath it (so a child is never orphaned), any filter/search change resets to
 * page 1, page numbers clamp when the set shrinks, and the pager drops its page NAVIGATION on a
 * single page — the count and the page-size picker stay, so the large choice that collapsed the set
 * can always be undone.
 *
 * The pagination unit is the RENDERED ROW — the exact flattened list the tree paints — so "Rows per
 * page 10" really shows 10 rows even when a root carries a subtree. This carries one accepted trade:
 * a page boundary may fall INSIDE a subtree, so a page can open on rows whose parent rendered on the
 * previous page. Every row still carries the real `depth` `buildTree` computed for it, so those rows
 * indent correctly rather than rendering flush-left as if they were top-level. Keeping whole
 * subtrees on one page was rejected precisely because it is what let the count and the page size
 * disagree.
 *
 * Paging is client-side over the department's already-fetched set; the department identity scoping
 * happened server-side.
 *
 * Capabilities are never computed here: `capabilities` comes off the route payload and is handed
 * straight to the header actions and the dialogs, which are the only things that decide which
 * actions to mount. The one exception the payload does not answer is per-row delete, and that
 * answer is the row's own server-computed `can_delete` — never a session flag, never an id comparison.
 */

function normaliseSearch(value: string): string {
    return value.trim().toLowerCase();
}

function cellKey(taskId: number, column: string): string {
    return `${taskId}:${column}`;
}

/** Nothing is saving — one shared identity so the common render hands the rows no new map. */
const NO_CELL_PATCHES: ReadonlyMap<string, TaskRowPatch> = new Map();

/** Nothing is collapsed / expanded — one shared identity so the derived sets stay stable. */
const EMPTY_ID_SET: ReadonlySet<number> = new Set();

/** The catalog ref an optimistic status/priority cell shows while the picked id is being saved. */
function catalogRefFor(options: readonly TaskCatalogOption[], id: number): TaskCatalogRef | null {
    const option = options.find((candidate) => candidate.id === id);
    return option === undefined ? null : { label: option.label, color: option.color, icon: option.icon };
}

interface CellEditContext {
    readonly catalogs: TaskCatalogs;
    readonly memberNameById: ReadonlyMap<number, string>;
    readonly updateTask: (taskId: number, input: UpdateTaskInput) => Promise<boolean>;
    readonly assign: (taskId: number, userId: number, label: string) => Promise<boolean>;
    readonly unassign: (taskId: number, userId: number, label: string) => Promise<boolean>;
}

interface CellEditOutcome {
    readonly patch: TaskRowPatch;
    readonly persist: () => Promise<boolean>;
}

/**
 * Turns a semantic cell edit into the module's EXISTING save calls — the same `updateTask` the
 * edit dialog uses for a task field and the same `assign` / `unassign` it uses for an assignment,
 * so the in-place cell adds no second data path.
 *
 * A no-op (the picked value is already the row's value, or a blank custom answer was already
 * absent) resolves to `null`, so the caller opens no write and shows no optimistic patch. A custom
 * answer mirrors the dialog exactly: blank is sent as `null` to CLEAR a stored answer, and is
 * omitted entirely when there was nothing stored to clear.
 */
function resolveCellEdit(
    task: TaskListItem,
    request: CellEditRequest,
    context: CellEditContext,
): CellEditOutcome | null {
    const nameOf = (userId: number): string =>
        context.memberNameById.get(userId) ?? `User #${userId}`;

    switch (request.kind) {
        case "title": {
            const title = request.value.trim();
            if (title === "" || title === task.title) return null;
            return { patch: { title }, persist: () => context.updateTask(task.id, { title }) };
        }
        case "status": {
            if (request.id === task.status_id) return null;
            return {
                patch: { status: catalogRefFor(context.catalogs.statuses, request.id) },
                persist: () => context.updateTask(task.id, { status_id: request.id }),
            };
        }
        case "priority": {
            if (request.id === task.priority_id) return null;
            return {
                patch: { priority: catalogRefFor(context.catalogs.priorities, request.id) },
                persist: () => context.updateTask(task.id, { priority_id: request.id }),
            };
        }
        case "assignees": {
            // The picked set is diffed against the row's current assignees, exactly as the edit
            // dialog diffs its picker: only the added are assigned and only the removed unassigned.
            const current = new Set(task.assignees.map((entry) => entry.user_id));
            const next = new Set(request.userIds);
            const added: number[] = [];
            for (const userId of request.userIds) {
                if (!current.has(userId)) added.push(userId);
            }
            const removed: number[] = [];
            for (const userId of current) {
                if (!next.has(userId)) removed.push(userId);
            }
            if (added.length === 0 && removed.length === 0) return null;

            // The cell shows the WHOLE chosen set immediately, named from the member directory.
            const assignees = request.userIds.map((userId) => ({
                user_id: userId,
                full_name: nameOf(userId),
            }));

            return {
                patch: { assignees },
                // One interaction is ONE persist, but it writes only the differences. Follows the
                // form's precedent (a per-member `assign` / `unassign`, each of which refreshes and
                // toasts) rather than inventing a batched endpoint.
                persist: async (): Promise<boolean> => {
                    let ok = true;
                    for (const userId of added) {
                        if (!(await context.assign(task.id, userId, nameOf(userId)))) ok = false;
                    }
                    for (const userId of removed) {
                        if (!(await context.unassign(task.id, userId, nameOf(userId)))) ok = false;
                    }
                    return ok;
                },
            };
        }
        case "date": {
            const current = request.field === "start" ? task.start_date : task.end_date;
            if (request.value === current) return null;

            // Only the edited side's key is sent, so the server merges it with the stored other
            // side — which is also what keeps the pair's `assertDateOrder` check meaningful.
            return request.field === "start"
                ? {
                      patch: { start_date: request.value },
                      persist: () => context.updateTask(task.id, { start_date: request.value }),
                  }
                : {
                      patch: { end_date: request.value },
                      persist: () => context.updateTask(task.id, { end_date: request.value }),
                  };
        }
        case "field": {
            const stored =
                task.custom_values.find((entry) => entry.field_id === request.fieldId)?.value ?? null;
            const trimmed = request.value === null ? "" : request.value.trim();
            const next = trimmed === "" ? null : trimmed;
            if (next === stored) return null;

            const remaining = task.custom_values.filter((entry) => entry.field_id !== request.fieldId);
            const customValues =
                next === null ? remaining : [...remaining, { field_id: request.fieldId, value: next }];
            return {
                patch: { custom_values: customValues },
                persist: () =>
                    context.updateTask(task.id, {
                        custom_values: [{ field_id: request.fieldId, value: next }],
                    }),
            };
        }
        default:
            return null;
    }
}

/**
 * The ids of every node in a (already pruned) forest that owns children.
 *
 * Filtering keeps an ancestor chain in the data, but `TaskTree` only renders the children of
 * EXPANDED nodes — so without this, a match under a collapsed ancestor would remain invisible.
 * While a filter is active these ids are unioned into the rendered expansion set, which reveals
 * every match's ancestor chain without mutating the user's own expand/collapse state.
 */
function expandableIds(nodes: readonly TreeNode<TaskTreeRow>[]): Set<number> {
    const ids = new Set<number>();
    const stack: TreeNode<TaskTreeRow>[] = [...nodes];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) continue;
        if (node.children.length > 0) ids.add(node.id);
        stack.push(...node.children);
    }
    return ids;
}

/**
 * The chain from the forest's root down to `targetId`, root-first, or an empty list when the id is
 * not in the tree. Iterative (an explicit stack), because sub-task depth is unbounded by design.
 */
function ancestorTrail(
    nodes: readonly TreeNode<TaskTreeRow>[],
    targetId: number,
): TaskBreadcrumb[] {
    const stack: { node: TreeNode<TaskTreeRow>; trail: TaskBreadcrumb[] }[] = [];
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        stack.push({ node: nodes[index], trail: [] });
    }

    while (stack.length > 0) {
        const frame = stack.pop();
        if (frame === undefined) continue;

        const trail = [...frame.trail, { id: frame.node.id, title: frame.node.title }];
        if (frame.node.id === targetId) return trail;
        for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
            stack.push({ node: frame.node.children[index], trail });
        }
    }

    return [];
}

function trailFor(
    nodes: readonly TreeNode<TaskTreeRow>[],
    targetId: number | null,
    includeTarget: boolean,
): TaskBreadcrumb[] {
    if (targetId === null) return [];
    const path = ancestorTrail(nodes, targetId);
    if (path.length === 0) return [];
    return includeTarget ? path : path.slice(0, -1);
}

export interface TasksModuleProps {
    /**
     * The signed-in user id, decoded from the session cookie by the page. It is used only to mark
     * the current member in the assignee filter — it never scopes a query and never gates an action.
     */
    readonly userId: number | null;
}

/**
 * The row a drop just moved, plus the `items` array the payload was computed against. Remembering
 * the array is what makes the optimistic patch self-expiring: a refetch always hands back a new
 * array, so a rejected move reverts without an extra code path.
 */
interface PendingTreeMove {
    readonly taskId: number;
    readonly payload: MoveTaskInput;
    readonly items: readonly TaskListItem[];
}

/** Stable row renderer: the sortable wrapper the dnd engine needs, defined once. */
function SortableRow(props: TaskRowProps) {
    return <SortableTaskRow {...props} />;
}

export function TasksModule({ userId }: TasksModuleProps) {
    /**
     * The switcher's source, and the owner of the one-shot default-list bootstrap: a department
     * whose head never ran the configuration seed still gets its "General" list without the task
     * read having to know about lists at all.
     */
    const { lists } = useTaskLists();

    /** The user's explicit choice. `null` means "not chosen yet" — the default list is used. */
    const [selectedListId, setSelectedListId] = useState<number | null>(null);

    /**
     * The list the page actually reads: the user's choice while it is still a LIVE list, otherwise
     * the department's default (the flagged row, else the first). Deriving the fallback instead of
     * storing it is what makes a list that a head deleted — or any change to the list set — fall
     * back to the default rather than stranding the page on an empty, unresolvable read.
     */
    const activeListId = useMemo(() => {
        if (selectedListId !== null && lists.some((list) => list.id === selectedListId)) {
            return selectedListId;
        }
        return (lists.find((list) => list.is_default) ?? lists[0])?.id ?? null;
    }, [selectedListId, lists]);

    const { items, catalogs, fields, isLoading, isRefreshing, error, capabilities, refresh, mergeTaskRow } =
        useTasks(activeListId);
    const {
        members,
        memberNameById,
        isSubmitting: isAssigneeSubmitting,
        error: assigneeError,
        assign,
        unassign,
    } = useAssignees({ onChanged: refresh });
    /**
     * The tag catalog is not fetched again — it rides on the tasks payload (`catalogs.tags`), so this
     * hook owns only the tag writes.
     */
    const {
        isSubmitting: isTagSubmitting,
        error: tagError,
        assignTag,
        unassignTag,
    } = useTags({ tags: catalogs.tags, onChanged: refresh });
    const {
        isSubmitting: isTaskSubmitting,
        error: mutationError,
        createTask,
        updateTask,
        deleteTask,
        moveTask,
        uploadAttachment,
        detachAttachment,
        clearError,
    } = useTaskMutations({ onChanged: refresh, onTaskUpdated: mergeTaskRow });
    /**
     * The dropped row renders in its new place immediately; the refetch that `moveTask` triggers
     * replaces it a moment later. Expiring on `items` identity keeps the two from disagreeing.
     */
    const [pendingMove, setPendingMove] = useState<PendingTreeMove | null>(null);
    const activeMove = pendingMove !== null && pendingMove.items === items ? pendingMove : null;
    const displayItems = useMemo(() => {
        if (activeMove === null) {
            return items;
        }
        const { taskId, payload } = activeMove;
        const siblingOrder = new Map(payload.sibling_ids.map((id, index) => [id, index]));
        return items.map((row) => {
            const sortOrder = siblingOrder.get(row.id);
            if (row.id === taskId) {
                return {
                    ...row,
                    parent_id: payload.parent_id,
                    sort_order: sortOrder ?? row.sort_order,
                };
            }
            return sortOrder === undefined ? row : { ...row, sort_order: sortOrder };
        });
    }, [items, activeMove]);
    const { roots, expandedIds, toggleExpand, expandAll, collapseAll } = useTaskTree(
        displayItems,
        memberNameById,
    );
    const { savedFilters, saveFilter, deleteFilter } = useSavedTaskFilters();

    /**
     * The live filter, shared with every other tab and persisted per browser — see
     * `useTaskFilterState`. It lives here rather than in the toolbar so switching tabs and reloading
     * both keep it. Groups combine with AND; rows inside a group combine by the group's own setting.
     * A clause with no field — or a value-taking clause with no value — is inactive, which is what
     * keeps picking a field from blanking the list.
     */
    const { search, groups, onSearchChange, onGroupsChange, clearFilters } = useTaskFilterState();
    const [page, setPage] = useState(1);
    /**
     * Roots per page. It is an INPUT to the page set, so changing it resets to page 1 exactly as a
     * search or filter change does — staying on page 3 of a set that now has two pages is the bug
     * this guards against. The choices and the default live with the pager.
     */
    const [pageSize, setPageSize] = useState<number>(DEFAULT_TASK_PAGE_SIZE);

    const [isCreateOpen, setIsCreateOpen] = useState(false);
    /** Which of the six views is showing. The list is the default and the only editable one. */
    const [view, setView] = useState<TasksViewId>("list");
    const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
    /**
     * The element that opened the detail sheet. Radix hands focus back to a dialog's trigger, and
     * this sheet has none, so the opener is kept here instead — see `handleDetailOpenChange`.
     */
    const detailReturnFocusRef = useRef<HTMLElement | null>(null);
    const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
    const [subtaskParentId, setSubtaskParentId] = useState<number | null>(null);

    /**
     * The ONE cell currently open for in-place editing, or `null`. Kept here rather than in the row
     * so only a single cell is ever open: opening a second one replaces it, which cancels the first.
     */
    const [editingCell, setEditingCell] = useState<{ taskId: number; column: string } | null>(null);
    /** The optimistic value each in-flight cell is showing until its refetch (or failure) lands. */
    const [cellPatches, setCellPatches] = useState<ReadonlyMap<string, TaskRowPatch>>(NO_CELL_PATCHES);
    /** The cells with a save in flight, so a double click cannot fire a second write for one cell. */
    const inFlightCellsRef = useRef<Set<string>>(new Set());

    const isDialogSubmitting = isTaskSubmitting || isAssigneeSubmitting || isTagSubmitting;

    const taskById = useMemo(() => {
        const map = new Map<number, TaskListItem>();
        for (const item of items) map.set(item.id, item);
        return map;
    }, [items]);

    const detailTask = detailTaskId === null ? null : (taskById.get(detailTaskId) ?? null);
    const editingTask = editingTaskId === null ? null : (taskById.get(editingTaskId) ?? null);
    const subtaskParent = subtaskParentId === null ? null : (taskById.get(subtaskParentId) ?? null);

    /**
     * The ONE assignees dialog's subject, derived from the single open cell. It is mounted once, at
     * module level, rather than per row — so the table carries one dialog however many rows it has.
     */
    const assigneeEditingTaskId =
        editingCell !== null && editingCell.column === "assignees" ? editingCell.taskId : null;
    const assigneeEditingTask =
        assigneeEditingTaskId === null ? null : (taskById.get(assigneeEditingTaskId) ?? null);
    const assigneeSelectedIds = useMemo(
        () => assigneeEditingTask?.assignees.map((assignee) => assignee.user_id) ?? [],
        [assigneeEditingTask],
    );

    /**
     * The ONE tags dialog, the same single-instance rule as the assignees one. Tagging is not a cell
     * edit — the cell just opens this modal — so its subject is its own id, not an `editingCell`.
     */
    const [tagsEditingTaskId, setTagsEditingTaskId] = useState<number | null>(null);
    const tagsEditingTask =
        tagsEditingTaskId === null ? null : (taskById.get(tagsEditingTaskId) ?? null);
    const tagsSelectedIds = useMemo(
        () => tagsEditingTask?.tags.map((tag) => tag.tag_id) ?? [],
        [tagsEditingTask],
    );

    const editingTrail = useMemo(
        () => trailFor(roots, editingTaskId, false),
        [roots, editingTaskId],
    );
    const subtaskTrail = useMemo(
        () => trailFor(roots, subtaskParentId, true),
        [roots, subtaskParentId],
    );

    const childCountById = useMemo(() => {
        const counts = new Map<number, number>();
        for (const item of items) {
            if (item.parent_id === null) continue;
            counts.set(item.parent_id, (counts.get(item.parent_id) ?? 0) + 1);
        }
        return counts;
    }, [items]);

    /** The custom columns this department still has — see `knownGroups`. */
    const fieldIds = useMemo<ReadonlySet<number>>(() => new Set(fields.map((field) => field.id)), [fields]);

    /** Every group that still names a live column — the set both the filter and the tree read. */
    const appliedGroups = useMemo(() => knownGroups(groups, fieldIds), [groups, fieldIds]);

    const isFiltering = normaliseSearch(search) !== "" || anyGroupActive(appliedGroups);

    /**
     * Identifies the filter currently applied. A collapse made while filtering is remembered against
     * this key only, so it lapses the moment the filter changes and the new matches are revealed
     * again — the same rule the Progress tab's collapse state follows.
     */
    const revealKey = useMemo(
        () =>
            `${normaliseSearch(search)}\u0000${appliedGroups
                .map(
                    (group) =>
                        `${group.operator}(${group.clauses
                            .map((clause) => `${clause.fieldKey}:${clause.operator}:${clause.value ?? ""}`)
                            .join("\u0001")})`,
                )
                .join("\u0002")}`,
        [search, appliedGroups],
    );

    /** Rows the user folded away UNDER the current filter. Empty for any other filter. */
    const [collapsedWhileFiltered, setCollapsedWhileFiltered] = useState<{
        readonly key: string;
        readonly ids: ReadonlySet<number>;
    }>({ key: "", ids: EMPTY_ID_SET });
    const collapsedFilteredIds =
        collapsedWhileFiltered.key === revealKey ? collapsedWhileFiltered.ids : EMPTY_ID_SET;

    /**
     * The forest the List renders. Groups combine with AND; inside a group a positive row keeps its
     * subtree and an `is not` row drops its branch — and search reveals ancestors.
     */
    const filteredRoots = useMemo(() => {
        const term = normaliseSearch(search);
        return pruneForest(roots, {
            passesClauses: (row) => rowMatchesFilter(row, appliedGroups, fields),
            failsExcludingClause: (row) => failsExcludingGroup(row, appliedGroups, fields),
            ...(term === "" ? {} : { matchesSearch: (row) => row.title.toLowerCase().includes(term) }),
        });
    }, [roots, search, appliedGroups, fields]);

    /**
     * Rows on screen only as the ancestor path of a match. A filter selects the rows it matches and
     * nothing else, so a parent can be visible while failing every clause; those rows are the
     * hierarchy around a hit, and rendering them muted keeps "kept for context" from reading as
     * "matched too". Empty when no filter or search is active.
     */
    const contextIds = useMemo<ReadonlySet<number>>(() => {
        if (!isFiltering) return EMPTY_ID_SET;
        const term = normaliseSearch(search);
        const gating = anyGroupActive(appliedGroups);
        const ids = new Set<number>();
        for (const row of items) {
            const passesFilter = !gating || rowMatchesFilter(row, appliedGroups, fields);
            const passesSearch = term === "" || row.title.toLowerCase().includes(term);
            if (!passesFilter || !passesSearch) ids.add(row.id);
        }
        return ids;
    }, [items, isFiltering, appliedGroups, fields, search]);

    const autoExpandedIds = useMemo(
        () => (isFiltering ? expandableIds(filteredRoots) : EMPTY_ID_SET),
        [isFiltering, filteredRoots],
    );

    /**
     * What the tree actually renders expanded. Without a filter it is the user's own set. WITH one,
     * the filter reveals every match's ancestors — and any row the user folded away under that same
     * filter stays folded, which is why a collapse used to look broken while filtering: the reveal
     * was unioned back in on every render.
     */
    const renderExpandedIds = useMemo<ReadonlySet<number>>(() => {
        if (!isFiltering) return expandedIds;
        if (collapsedFilteredIds.size === 0) return autoExpandedIds;

        const merged = new Set(autoExpandedIds);
        for (const id of collapsedFilteredIds) merged.delete(id);
        return merged;
    }, [isFiltering, expandedIds, autoExpandedIds, collapsedFilteredIds]);

    /**
     * Every parent id in the WHOLE forest — the universe the `Subtasks` control's `Expanded` mode
     * means. It is computed off `roots` (not the filtered or paged slice) so the derived mode is
     * stable across a page change or a filter, and it matches what the hook's `expandAll` seeds.
     */
    const expandableRootIds = useMemo(() => expandableIds(roots), [roots]);

    /**
     * The `Subtasks` control is a MODE, not a command, and its active option is DERIVED here rather
     * than stored: `Expanded` holds exactly while every expandable row ON SCREEN is expanded. That is
     * what keeps the checkmark honest — collapsing one row by hand drops it back to `Collapsed` with
     * no parallel flag to fall out of sync. Under a filter the universe is the filtered forest, since
     * the rows a filter hides cannot be expanded or collapsed by the user anyway.
     */
    const isSubtasksExpanded = useMemo(() => {
        const universe = isFiltering ? autoExpandedIds : expandableRootIds;
        if (universe.size === 0) return false;
        for (const id of universe) {
            if (!renderExpandedIds.has(id)) return false;
        }
        return true;
    }, [isFiltering, autoExpandedIds, expandableRootIds, renderExpandedIds]);

    /**
     * Every row the tree can render, in render order: the filtered forest with the active expansion
     * state applied. This is the pagination unit — the SAME flattened list `TaskTree` paints (it is
     * handed `pagedRows` below), so the page count, the slice and the footer all count rows, never
     * roots.
     */
    const visibleRows = useMemo(
        () => flattenVisible(filteredRoots, renderExpandedIds),
        [filteredRoots, renderExpandedIds],
    );

    const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
    /*
     * The page is CLAMPED at read time rather than written back through an effect: `page` may hold a
     * stale number for one render after the set shrinks, but every consumer — the slice and the
     * pager — reads this clamped value, so a deleted, filtered-away or newly-collapsed page can
     * never strand the user on an empty page. Expanding/collapsing changes the ROW count and so the
     * page count, which this clamp also covers. Every input change resets `page` to 1, so the stale
     * value is unobservable.
     */
    const currentPage = Math.min(page, totalPages);

    // The slice is taken over RENDERED ROWS, so a page boundary can fall inside a subtree. The rows
    // keep the true `depth` `buildTree` gave them, so indentation stays right on a mid-subtree page.
    const pagedRows = useMemo(
        () => visibleRows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
        [visibleRows, currentPage, pageSize],
    );

    const handleSearchChange = useCallback(
        (value: string) => {
            onSearchChange(value);
            setPage(1);
        },
        [onSearchChange],
    );

    const handleGroupsChange = useCallback(
        (next: readonly FilterGroup[]) => {
            onGroupsChange(next);
            setPage(1);
        },
        [onGroupsChange],
    );

    /** Applying a saved set restores fresh group and row ids, so they never collide with the live ones. */
    const handleApplySavedFilter = useCallback(
        (filter: SavedTaskFilter) => {
            onGroupsChange(cloneGroupsForApply(filter.groups));
            setPage(1);
        },
        [onGroupsChange],
    );

    const handleClearFilters = useCallback(() => {
        clearFilters();
        setPage(1);
    }, [clearFilters]);

    /**
     * The `Subtasks` control's two choices. While filtering they fold UNFOLD the filtered forest,
     * which is what the user is looking at; the hook's own set is left alone so clearing the filter
     * returns the tree to the expansion state it had before.
     */
    const handleSubtasksExpandedChange = useCallback(
        (expanded: boolean): void => {
            if (!isFiltering) {
                if (expanded) expandAll();
                else collapseAll();
                return;
            }
            setCollapsedWhileFiltered({
                key: revealKey,
                ids: expanded ? EMPTY_ID_SET : new Set(autoExpandedIds),
            });
        },
        [isFiltering, expandAll, collapseAll, revealKey, autoExpandedIds],
    );

    /**
     * A chevron click. While filtering it folds the row for the duration of THIS filter, since the
     * reveal would otherwise re-expand it on the next render.
     */
    const handleToggleExpand = useCallback(
        (id: number): void => {
            if (!isFiltering) {
                toggleExpand(id);
                return;
            }

            const willCollapse = renderExpandedIds.has(id);
            setCollapsedWhileFiltered((previous) => {
                const base = new Set(previous.key === revealKey ? previous.ids : EMPTY_ID_SET);
                if (willCollapse) base.add(id);
                else base.delete(id);
                return { key: revealKey, ids: base };
            });
        },
        [isFiltering, renderExpandedIds, revealKey, toggleExpand],
    );

    const handleRefresh = useCallback(() => {
        void refresh();
    }, [refresh]);

    /**
     * A drop persists through the pinned `{ parent_id, sibling_ids }` contract. `moveTask` refetches
     * on success; on failure it does not, so the revert that clears the optimistic patch has to be
     * asked for explicitly.
     */
    const handleTreeMove = useCallback(
        (activeId: number, payload: MoveTaskInput): void => {
            setPendingMove({ taskId: activeId, payload, items });
            void moveTask(activeId, payload).then((moved) => {
                if (!moved) {
                    void refresh();
                }
            });
        },
        [items, moveTask, refresh],
    );

    const handlePageChange = useCallback(
        (next: number) => {
            setPage(Math.max(1, Math.min(next, totalPages)));
        },
        [totalPages],
    );

    /**
     * A page-size change is an input change, so it lands on page 1 — the old size's page indices
     * mean nothing under the new one.
     */
    const handlePageSizeChange = useCallback((next: number): void => {
        setPageSize(next);
        setPage(1);
    }, []);

    /**
     * The create seam the toolbar calls. Landing the dialog changes nothing about that contract: it
     * still just opens the create form.
     */
    const handleCreateTask = useCallback((): void => {
        setIsCreateOpen(true);
    }, []);

    /**
     * The switcher's selection seam. The resolved fallback stays derived, never stored, and the page
     * lands on 1 exactly as it does for a search or filter change — the new list's rows have nothing
     * to do with the old page index.
     */
    const handleSelectList = useCallback((id: number): void => {
        setSelectedListId(id);
        setPage(1);
    }, []);

    /**
     * The create seam the dialogs call. The list in view is stamped onto every new task, so a task
     * created while a list is selected lands in THAT list instead of the department default — which
     * is what keeps the refetch that follows the create showing the task that was just made. An
     * input that already names a list (none does today) still wins.
     */
    const persistCreateTask = useCallback(
        (input: CreateTaskInput) =>
            createTask({ ...input, list_id: input.list_id ?? activeListId ?? undefined }),
        [createTask, activeListId],
    );

    // Each dialog's open state is derived from its subject id, so closing is "forget the subject".
    const handleCreateOpenChange = useCallback(
        (next: boolean): void => {
            setIsCreateOpen(next);
            if (!next) clearError();
        },
        [clearError],
    );

    const handleDetailOpenChange = useCallback((next: boolean): void => {
        if (next) return;
        setDetailTaskId(null);
        // The opener may be gone (its row was deleted, the view changed): only a live element can
        // take focus back. The move waits a frame because the dialog's focus scope is still
        // mounted for the rest of this tick and drags focus back into itself.
        const opener = detailReturnFocusRef.current;
        detailReturnFocusRef.current = null;
        if (opener === null) return;
        requestAnimationFrame(() => {
            if (opener.isConnected) opener.focus({ preventScroll: true });
        });
    }, []);

    const handleEditOpenChange = useCallback(
        (next: boolean): void => {
            if (next) return;
            setEditingTaskId(null);
            clearError();
        },
        [clearError],
    );

    const handleSubtaskOpenChange = useCallback(
        (next: boolean): void => {
            if (next) return;
            setSubtaskParentId(null);
            clearError();
        },
        [clearError],
    );

    const handleEditDetail = useCallback((): void => {
        setEditingTaskId(detailTaskId);
    }, [detailTaskId]);

    const handleAddSubtask = useCallback((): void => {
        setSubtaskParentId(detailTaskId);
    }, [detailTaskId]);

    /** The row's `+` names its own parent, so the sheet does not have to be open first. */
    const handleAddSubtaskFor = useCallback((taskId: number): void => {
        setSubtaskParentId(taskId);
    }, []);

    const handleDeleteTask = useCallback(
        async (task: TaskListItem): Promise<boolean> => deleteTask(task.id, task.title),
        [deleteTask],
    );

    const handleStartCellEdit = useCallback((taskId: number, column: string): void => {
        if (inFlightCellsRef.current.has(cellKey(taskId, column))) return;
        setEditingCell({ taskId, column });
    }, []);

    const handleCancelCellEdit = useCallback((): void => {
        setEditingCell(null);
    }, []);

    /**
     * Saves one cell edit through the module's existing mutation path.
     *
     * The cell closes at once, its resolved value is shown optimistically, and the patch is dropped
     * as soon as the write settles: a success has already refetched the server's truth, and a
     * failure leaves the rows untouched — so dropping the patch is exactly the revert. The mutation
     * hooks own the error surfacing (toast + the module's persistent alert), so a failed cell needs
     * nothing else here.
     */
    const handleCellCommit = useCallback(
        (taskId: number, column: string, request: CellEditRequest): void => {
            const key = cellKey(taskId, column);
            if (inFlightCellsRef.current.has(key)) return;

            setEditingCell(null);

            const task = taskById.get(taskId);
            if (task === undefined) return;

            const outcome = resolveCellEdit(task, request, {
                catalogs,
                memberNameById,
                updateTask,
                assign,
                unassign,
            });
            if (outcome === null) return;

            inFlightCellsRef.current.add(key);
            setCellPatches((previous) => {
                const next = new Map(previous);
                next.set(key, outcome.patch);
                return next;
            });

            void (async (): Promise<void> => {
                await outcome.persist();
                setCellPatches((previous) => {
                    if (!previous.has(key)) return previous;
                    const next = new Map(previous);
                    next.delete(key);
                    return next;
                });
                inFlightCellsRef.current.delete(key);
            })();
        },
        [taskById, catalogs, memberNameById, updateTask, assign, unassign],
    );

    const handleAssigneeDialogOpenChange = useCallback(
        (next: boolean): void => {
            if (!next) handleCancelCellEdit();
        },
        [handleCancelCellEdit],
    );

    /**
     * Commit the modal's chosen set through the SAME cell-edit path the inline editors use: it is
     * diffed against the row's current assignees and only the differences are written through the
     * assignees route. An unchanged set resolves to no-op and writes nothing.
     */
    const handleAssigneeSave = useCallback(
        (userIds: readonly number[]): void => {
            if (assigneeEditingTaskId === null) return;
            handleCellCommit(assigneeEditingTaskId, "assignees", { kind: "assignees", userIds });
        },
        [assigneeEditingTaskId, handleCellCommit],
    );

    const handleOpenTags = useCallback((taskId: number): void => {
        setTagsEditingTaskId(taskId);
    }, []);

    const handleTagsDialogOpenChange = useCallback((next: boolean): void => {
        if (!next) setTagsEditingTaskId(null);
    }, []);

    /**
     * The modal hands back a whole set, so it is diffed here against the row's current tags and only
     * the differences hit the tasks/<id>/tags route. `assignTag`/`unassignTag` already refetch.
     */
    const handleTagsSave = useCallback(
        (tagIds: readonly number[]): void => {
            if (tagsEditingTask === null) return;
            const taskId = tagsEditingTask.id;
            const current = new Set(tagsEditingTask.tags.map((tag) => tag.tag_id));
            const next = new Set(tagIds);
            const labelOf = (tagId: number): string =>
                catalogs.tags.find((tag) => tag.id === tagId)?.label ?? `Tag #${tagId}`;

            setTagsEditingTaskId(null);
            void (async (): Promise<void> => {
                for (const tagId of next) {
                    if (!current.has(tagId)) await assignTag(taskId, tagId, labelOf(tagId));
                }
                for (const tagId of current) {
                    if (!next.has(tagId)) await unassignTag(taskId, tagId, labelOf(tagId));
                }
            })();
        },
        [tagsEditingTask, catalogs.tags, assignTag, unassignTag],
    );

    const handleOpenTask = useCallback((taskId: number): void => {
        /**
         * Where focus was when the sheet opened. Radix returns focus to a dialog's TRIGGER, and this
         * sheet is opened by a row, a card or a details button rather than a trigger of its own — so
         * without remembering the opener, closing the sheet drops a keyboard user on `<body>` and
         * their place in the grid is gone. Every view opens through here, so this is the one seam.
         */
        const active = document.activeElement;
        detailReturnFocusRef.current = active instanceof HTMLElement ? active : null;
        setDetailTaskId(taskId);
    }, []);

    const renderRowActions = useCallback((node: TreeNode<TaskRowView>) => {
        const detailsLabel = `View details for ${node.title}`;
        return (
            <div className="flex items-center justify-end gap-0.5">
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={detailsLabel}
                    title={detailsLabel}
                    data-slot="task-row-details"
                    onClick={() => handleOpenTask(node.id)}
                >
                    <Eye className="size-4" aria-hidden="true" />
                </Button>
            </div>
        );
    }, [handleOpenTask]);

    /**
     * The shared contract every non-list view reads. Built once here so the five views cannot drift
     * in what they are handed — the same flat rows, catalogs, directory and retry, plus the two
     * seams a view may opt into: opening the read view, and committing one field change.
     *
     * Both are OPTIONAL. A view handed neither is exactly as read-only as before; only the board is
     * handed `onCellCommit`, and that is what makes its cards draggable — so the capability and the
     * contract cannot disagree.
     */
    const viewProps = useMemo<TaskViewProps>(
        () => ({
            items,
            catalogs,
            memberNameById,
            fields,
            isLoading,
            error,
            onRetry: handleRefresh,
            onOpenTask: handleOpenTask,
            onCellCommit: handleCellCommit,
        }),
        [
            items,
            catalogs,
            memberNameById,
            fields,
            isLoading,
            error,
            handleRefresh,
            handleOpenTask,
            handleCellCommit,
        ],
    );

    const surfaceError = error ?? mutationError ?? assigneeError ?? tagError;
    const showError = surfaceError !== null && surfaceError !== "";
    const emptyMessage = isFiltering
        ? "No tasks match the current search and filters."
        : "No tasks yet. Create the first task to get started.";

    /*
     * Deliberately FULL-WIDTH — no `mx-auto max-w-*` cap. The resizable task grid is fixed-width
     * (sum of its column widths) inside its own horizontal-scroll container, so a centred max-w box
     * only adds dead margin either side and, worse, starves the grid of room and forces it to
     * overflow. When it overflows and scrolls, the opaque frozen leading columns slide over the
     * columns beneath them — which is what hid the Start column. The `px-4` gutter (on top of the
     * page's own `p-2 sm:p-4`) is the only breathing room the grid needs, and it does not leak into
     * any sibling module: this section belongs to the tasks page alone.
     */
    return (
        <section
            data-slot="tasks-module"
            className="w-full scroll-pt-16 space-y-4 px-4 py-6 md:scroll-pt-20"
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <h1 className="min-w-0 text-lg font-semibold tracking-tight">Tasks</h1>

                <TasksHeaderActions capabilities={capabilities} onCreateTask={handleCreateTask} />
            </div>

            {/*
             * The view tabs and the list switcher share one row: tabs pinned left, the switcher
             * pinned right. The switcher is a PAGE-level scope — which list's tasks every view
             * projects, a different axis from which view — so it rides beside the tabs rather than
             * in the toolbar's search row or under the page actions. `flex-wrap` is deliberate:
             * when the six labelled tabs and the switcher cannot both fit — narrow viewports, and
             * the band just above `sm` where the tab labels reappear — the switcher wraps to its
             * own right-aligned line instead of squeezing the tabs into slivers. Below `sm` the row
             * is already stacked.
             */}
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <TasksViewTabs value={view} onValueChange={setView} />
                <TaskListSwitcher
                    lists={lists}
                    selectedId={activeListId}
                    onSelect={handleSelectList}
                />
            </div>

            {/*
             * The six extra views are read-only projections of the SAME rows the list renders, so
             * they are mounted only while selected: the Gantt pulls a third-party timeline and the
             * Dashboard mounts three charts, and neither should cost anything on another view. The
             * list stays mounted but hidden so its expand state and scroll position survive a switch.
             */}
            {view !== "list" ? (
                <>
                    {view === "board" ? <BoardView {...viewProps} /> : null}
                    {view === "calendar" ? <CalendarView {...viewProps} /> : null}
                    {view === "team" ? <TeamView {...viewProps} /> : null}
                    {view === "gantt" ? <GanttView {...viewProps} /> : null}
                    {view === "dashboard" ? <DashboardView {...viewProps} /> : null}
                    {view === "progress" ? <ProgressView {...viewProps} /> : null}
                </>
            ) : null}

            <div
                data-slot="tasks-list-view"
                className={view === "list" ? "space-y-4" : "hidden"}
            >
            {showError ? (
                <Alert variant="destructive" data-slot="tasks-error">
                    <AlertTriangle className="size-4" aria-hidden="true" />
                    <AlertTitle>Tasks unavailable</AlertTitle>
                    <AlertDescription className="flex flex-col items-start gap-2">
                        <span>{surfaceError}</span>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleRefresh}
                            disabled={isRefreshing}
                        >
                            <RotateCcw className="size-4" aria-hidden="true" />
                            Try again
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}

            <TasksToolbar
                searchValue={search}
                onSearchChange={handleSearchChange}
                groups={groups}
                onGroupsChange={handleGroupsChange}
                fields={fields}
                statuses={catalogs.statuses}
                priorities={catalogs.priorities}
                tags={catalogs.tags}
                members={members}
                currentUserId={userId}
                savedFilters={savedFilters}
                onSaveFilter={saveFilter}
                onApplySavedFilter={handleApplySavedFilter}
                onDeleteSavedFilter={deleteFilter}
                isFiltering={isFiltering}
                onClearFilters={handleClearFilters}
                isRefreshing={isRefreshing}
                onRefresh={handleRefresh}
                isSubtasksExpanded={isSubtasksExpanded}
                onSubtasksExpandedChange={handleSubtasksExpandedChange}
            />

            <TreeDndProvider
                roots={filteredRoots}
                expandedIds={renderExpandedIds}
                allRows={items}
                reorderDisabled={isFiltering}
                onMove={handleTreeMove}
            >
                <TaskTree
                roots={filteredRoots}
                rows={pagedRows}
                contextIds={contextIds}
                renderRow={SortableRow}
                expandedIds={renderExpandedIds}
                onToggleExpand={handleToggleExpand}
                isLoading={isLoading}
                error={error}
                onRetry={handleRefresh}
                emptyMessage={emptyMessage}
                fields={fields}
                catalogs={catalogs}
                members={members}
                editingCell={editingCell}
                cellPatches={cellPatches}
                onStartCellEdit={handleStartCellEdit}
                onCancelCellEdit={handleCancelCellEdit}
                onCommitCellEdit={handleCellCommit}
                onEditTags={handleOpenTags}
                onAddSubtask={handleAddSubtaskFor}
                renderActions={renderRowActions}
                aria-label="Task list"
            />
            </TreeDndProvider>

            {/*
             * The pager is pinned BELOW the tree and outside its horizontal-scroll container, so one
             * pager drives both the wide table and the narrow card layout and never scrolls out of
             * reach. It is withheld entirely while loading, on error, or when the filtered set is
             * empty — an empty list shows the existing empty state, never "Page 1 of 0".
             */}
            {!isLoading && !showError && visibleRows.length > 0 ? (
                <TaskPagination
                    page={currentPage}
                    totalPages={totalPages}
                    totalRows={visibleRows.length}
                    pageSize={pageSize}
                    onPageChange={handlePageChange}
                    onPageSizeChange={handlePageSizeChange}
                />
            ) : null}
            </div>

            <TaskFormDialog
                open={isCreateOpen}
                onOpenChange={handleCreateOpenChange}
                task={null}
                parent={null}
                parentTrail={[]}
                catalogs={catalogs}
                members={members}
                capabilities={capabilities}
                isSubmitting={isDialogSubmitting}
                onCreate={persistCreateTask}
                onUpdate={updateTask}
                onAssign={assign}
                onUnassign={unassign}
                onAssignTag={assignTag}
                onUnassignTag={unassignTag}
            />

            <TaskFormDialog
                open={editingTask !== null}
                onOpenChange={handleEditOpenChange}
                task={editingTask}
                parent={null}
                parentTrail={editingTrail}
                catalogs={catalogs}
                members={members}
                capabilities={capabilities}
                isSubmitting={isDialogSubmitting}
                onCreate={persistCreateTask}
                onUpdate={updateTask}
                onAssign={assign}
                onUnassign={unassign}
                onAssignTag={assignTag}
                onUnassignTag={unassignTag}
            />

            <SubtaskCreateDialog
                open={subtaskParent !== null}
                onOpenChange={handleSubtaskOpenChange}
                parent={
                    subtaskParent === null
                        ? null
                        : { id: subtaskParent.id, title: subtaskParent.title }
                }
                parentTrail={subtaskTrail}
                catalogs={catalogs}
                members={members}
                capabilities={capabilities}
                isSubmitting={isDialogSubmitting}
                onCreate={persistCreateTask}
                onUpdate={updateTask}
                onAssign={assign}
                onUnassign={unassign}
                onAssignTag={assignTag}
                onUnassignTag={unassignTag}
            />

            <TaskDetailSheet
                open={detailTaskId !== null}
                onOpenChange={handleDetailOpenChange}
                task={detailTask}
                childCount={detailTaskId === null ? 0 : (childCountById.get(detailTaskId) ?? 0)}
                memberNameById={memberNameById}
                fields={fields}
                capabilities={capabilities}
                isSubmitting={isDialogSubmitting}
                onEdit={handleEditDetail}
                onAddSubtask={handleAddSubtask}
                onDelete={handleDeleteTask}
                onUploadAttachment={uploadAttachment}
                onDetachAttachment={detachAttachment}
                tags={catalogs.tags}
                onAssignTag={assignTag}
                onUnassignTag={unassignTag}
            />

            {/*
             * One instance for the whole table, opened when the editing cell is a task's assignees
             * column. Its Save flows back through `handleCellCommit`, so the assignees route and the
             * no-op diff stay exactly the ones the inline editors used.
             */}
            <AssigneeDialog
                open={assigneeEditingTask !== null}
                onOpenChange={handleAssigneeDialogOpenChange}
                task={
                    assigneeEditingTask === null
                        ? null
                        : { id: assigneeEditingTask.id, title: assigneeEditingTask.title }
                }
                members={members}
                selectedIds={assigneeSelectedIds}
                isSubmitting={isAssigneeSubmitting}
                onSave={handleAssigneeSave}
            />

            <TaskTagsDialog
                open={tagsEditingTask !== null}
                onOpenChange={handleTagsDialogOpenChange}
                task={
                    tagsEditingTask === null
                        ? null
                        : { id: tagsEditingTask.id, title: tagsEditingTask.title }
                }
                tags={catalogs.tags}
                selectedIds={tagsSelectedIds}
                isSubmitting={isTagSubmitting}
                onSave={handleTagsSave}
            />
        </section>
    );
}

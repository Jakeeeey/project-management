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
import { TasksHeaderActions } from "./components/TasksHeaderActions";
import { TasksToolbar } from "./components/TasksToolbar";
import {
    anyClauseActive,
    cloneClausesForApply,
    rowMatchesClauses,
    type FilterClause,
    type SavedTaskFilter,
} from "./components/task-filter";
import { TasksViewTabs } from "./components/TasksViewTabs";
import { BoardView } from "./components/views/BoardView";
import { CalendarView } from "./components/views/CalendarView";
import { DashboardView } from "./components/views/DashboardView";
import { GanttView } from "./components/views/GanttView";
import { TeamView } from "./components/views/TeamView";
import type { CellEditRequest } from "./components/TaskCellEditor";
import type { TaskRowPatch, TaskRowView } from "./components/TaskRow";
import type { TaskViewProps, TasksViewId } from "./types/task-view";
import { useAssignees } from "./hooks/useAssignees";
import { useSavedTaskFilters } from "./hooks/useSavedTaskFilters";
import {
    useTasks,
    type TaskCatalogOption,
    type TaskCatalogRef,
    type TaskCatalogs,
    type TaskField,
    type TaskListItem,
} from "./hooks/useTasks";
import { useTaskMutations } from "./hooks/useTaskMutations";
import { useTaskLists } from "./hooks/useTaskLists";
import { useTaskTree, type TaskTreeRow } from "./hooks/useTaskTree";
import type { CreateTaskInput, UpdateTaskInput } from "./types/pm-task.schema";

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

/** Case- and whitespace-insensitive search term, used for the match and the empty copy. */
function normaliseSearch(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Does one row satisfy the active search and every active clause?
 *
 * The search term is its own thing — it is not a clause and is never persisted. Clauses combine with
 * AND, and the per-clause semantics (empty, contains, choice ids, the assignee list) live in
 * `task-filter.ts`, so this stays the row-level conjunction alone.
 */
function rowMatches(
    row: TaskTreeRow,
    search: string,
    clauses: readonly FilterClause[],
    fields: readonly TaskField[],
): boolean {
    const term = normaliseSearch(search);
    if (term !== "" && !row.title.toLowerCase().includes(term)) return false;
    return rowMatchesClauses(row, clauses, fields);
}

/** The `"<taskId>:<column>"` key the open cell, its in-flight guard and its optimistic patch share. */
function cellKey(taskId: number, column: string): string {
    return `${taskId}:${column}`;
}

/** Nothing is saving — one shared identity so the common render hands the rows no new map. */
const NO_CELL_PATCHES: ReadonlyMap<string, TaskRowPatch> = new Map();

/** The catalog ref an optimistic status/priority cell shows while the picked id is being saved. */
function catalogRefFor(options: readonly TaskCatalogOption[], id: number): TaskCatalogRef | null {
    const option = options.find((candidate) => candidate.id === id);
    return option === undefined ? null : { label: option.label, color: option.color, icon: option.icon };
}

/** Everything `resolveCellEdit` needs beyond the row and the request. */
interface CellEditContext {
    readonly catalogs: TaskCatalogs;
    readonly memberNameById: ReadonlyMap<number, string>;
    readonly updateTask: (taskId: number, input: UpdateTaskInput) => Promise<boolean>;
    readonly assign: (taskId: number, userId: number, label: string) => Promise<boolean>;
    readonly unassign: (taskId: number, userId: number, label: string) => Promise<boolean>;
}

/** A resolved cell edit: the value to show immediately, and the write that makes it true. */
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

/** The trail a dialog shows: the ancestors only, or the ancestors plus the node itself. */
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

    const { items, catalogs, fields, isLoading, isRefreshing, error, capabilities, refresh } = useTasks(activeListId);
    const {
        members,
        memberNameById,
        isSubmitting: isAssigneeSubmitting,
        error: assigneeError,
        assign,
        unassign,
    } = useAssignees({ onChanged: refresh });
    const {
        isSubmitting: isTaskSubmitting,
        error: mutationError,
        createTask,
        updateTask,
        deleteTask,
        uploadAttachment,
        detachAttachment,
        clearError,
    } = useTaskMutations({ onChanged: refresh });
    const { roots, expandedIds, toggleExpand, expandAll, collapseAll } = useTaskTree(
        items,
        memberNameById,
    );
    const { savedFilters, saveFilter, deleteFilter } = useSavedTaskFilters();

    const [search, setSearch] = useState("");
    /**
     * The active filter clauses, combined with AND. A clause with no field — or a value-taking clause
     * with no value — is inactive, which is what keeps picking a field from blanking the list.
     */
    const [clauses, setClauses] = useState<readonly FilterClause[]>([]);
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

    const isDialogSubmitting = isTaskSubmitting || isAssigneeSubmitting;

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

    const detailTrail = useMemo(
        () => trailFor(roots, detailTaskId, false),
        [roots, detailTaskId],
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

    const isFiltering = normaliseSearch(search) !== "" || anyClauseActive(clauses);

    const filteredRoots = useMemo(
        () => pruneForest(roots, (row) => rowMatches(row, search, clauses, fields)),
        [roots, search, clauses, fields],
    );

    const autoExpandedIds = useMemo(
        () => (isFiltering ? expandableIds(filteredRoots) : new Set<number>()),
        [isFiltering, filteredRoots],
    );

    const renderExpandedIds = useMemo<ReadonlySet<number>>(() => {
        if (autoExpandedIds.size === 0) return expandedIds;
        const merged = new Set(expandedIds);
        for (const id of autoExpandedIds) merged.add(id);
        return merged;
    }, [expandedIds, autoExpandedIds]);

    /**
     * Every parent id in the WHOLE forest — the universe the `Subtasks` control's `Expanded` mode
     * means. It is computed off `roots` (not the filtered or paged slice) so the derived mode is
     * stable across a page change or a filter, and it matches what the hook's `expandAll` seeds.
     */
    const expandableRootIds = useMemo(() => expandableIds(roots), [roots]);

    /**
     * The `Subtasks` control is a MODE, not a command, and its active option is DERIVED here rather
     * than stored: `Expanded` holds exactly while the user's own `expandedIds` covers every
     * expandable row. That is what keeps the checkmark honest — collapsing one row by hand drops it
     * back to `Collapsed` with no parallel flag to fall out of sync. The filtered auto-reveal
     * (`autoExpandedIds`) is intentionally not consulted: it is a transient view guarantee, not a
     * user choice, so it must not make an unexpanded tree report itself as `Expanded`.
     */
    const isSubtasksExpanded = useMemo(() => {
        if (expandableRootIds.size === 0) return false;
        for (const id of expandableRootIds) {
            if (!expandedIds.has(id)) return false;
        }
        return true;
    }, [expandableRootIds, expandedIds]);

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

    const handleSearchChange = useCallback((value: string) => {
        setSearch(value);
        setPage(1);
    }, []);

    const handleClausesChange = useCallback((next: readonly FilterClause[]) => {
        setClauses(next);
        setPage(1);
    }, []);

    /** Applying a saved set restores fresh clause rows, so its ids never collide with the live ones. */
    const handleApplySavedFilter = useCallback((filter: SavedTaskFilter) => {
        setClauses(cloneClausesForApply(filter.clauses));
        setPage(1);
    }, []);

    const handleClearFilters = useCallback(() => {
        setSearch("");
        setClauses([]);
        setPage(1);
    }, []);

    /**
     * The `Subtasks` control's two choices drive the hook's own `expandAll` / `collapseAll`, so the
     * toolbar writes the SAME `expandedIds` the per-row chevrons toggle. `Collapsed` clears the
     * user's set only: a filter's ancestor reveal lives in `autoExpandedIds`, so a filtered match
     * stays visible even while this is `Collapsed`.
     */
    const handleSubtasksExpandedChange = useCallback(
        (expanded: boolean): void => {
            if (expanded) expandAll();
            else collapseAll();
        },
        [expandAll, collapseAll],
    );

    const handleRefresh = useCallback(() => {
        void refresh();
    }, [refresh]);

    /**
     * The shared contract every non-list view reads. Built once here so the five views cannot drift
     * in what they are handed — they all see the same flat rows, catalogs, directory and retry.
     */
    const viewProps = useMemo<TaskViewProps>(
        () => ({ items, catalogs, memberNameById, fields, isLoading, error, onRetry: handleRefresh }),
        [items, catalogs, memberNameById, fields, isLoading, error, handleRefresh],
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
        if (!next) setDetailTaskId(null);
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

    /** Closing the assignees dialog (Cancel, X or the overlay) abandons the change. */
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

    /**
     * The per-row actions the tree renders: open the detail sheet.
     */
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
                    onClick={() => setDetailTaskId(node.id)}
                >
                    <Eye className="size-4" aria-hidden="true" />
                </Button>
            </div>
        );
    }, []);

    const surfaceError = error ?? mutationError ?? assigneeError;
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
             * The five extra views are read-only projections of the SAME rows the list renders, so
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
                clauses={clauses}
                onClausesChange={handleClausesChange}
                fields={fields}
                statuses={catalogs.statuses}
                priorities={catalogs.priorities}
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

            <TaskTree
                roots={filteredRoots}
                rows={pagedRows}
                expandedIds={renderExpandedIds}
                onToggleExpand={toggleExpand}
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
                renderActions={renderRowActions}
                aria-label="Task list"
            />

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
            />

            <TaskDetailSheet
                open={detailTaskId !== null}
                onOpenChange={handleDetailOpenChange}
                task={detailTask}
                parentTrail={detailTrail}
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
        </section>
    );
}

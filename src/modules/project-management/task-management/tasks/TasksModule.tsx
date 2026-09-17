"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, Eye, RotateCcw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Pagination,
    PaginationContent,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from "@/components/ui/pagination";
import type { TreeNode } from "@/modules/project-management/utils/tree";

import { AssigneeDialog } from "./components/AssigneeDialog";
import { SortableTaskRow } from "./components/tree-dnd/SortableTaskRow";
import { TreeDndProvider } from "./components/tree-dnd/TreeDndProvider";
import { SubtaskCreateDialog } from "./components/SubtaskCreateDialog";
import { TaskDetailSheet } from "./components/TaskDetailSheet";
import { TaskFormDialog, type TaskBreadcrumb } from "./components/TaskFormDialog";
import { TaskTree } from "./components/TaskTree";
import { TasksHeaderActions } from "./components/TasksHeaderActions";
import { TasksToolbar } from "./components/TasksToolbar";
import {
    customFieldIdFromKey,
    isFieldFilterActive,
    NO_FIELD_FILTER,
    PRIORITY_FIELD_KEY,
    STATUS_FIELD_KEY,
    type FieldFilterClause,
} from "./components/TaskFieldFilter";
import { TasksViewTabs } from "./components/TasksViewTabs";
import { BoardView } from "./components/views/BoardView";
import { CalendarView } from "./components/views/CalendarView";
import { DashboardView } from "./components/views/DashboardView";
import { GanttView } from "./components/views/GanttView";
import { TeamView } from "./components/views/TeamView";
import type { CellEditRequest } from "./components/TaskCellEditor";
import type { TaskRowPatch, TaskRowProps, TaskRowView } from "./components/TaskRow";
import type { TaskViewProps, TasksViewId } from "./types/task-view";
import { useAssignees } from "./hooks/useAssignees";
import {
    useTasks,
    type TaskCatalogOption,
    type TaskCatalogRef,
    type TaskCatalogs,
    type TaskField,
    type TaskListItem,
} from "./hooks/useTasks";
import { useTaskMutations } from "./hooks/useTaskMutations";
import { useTaskTree, type TaskTreeRow } from "./hooks/useTaskTree";
import type { MoveTaskInput, UpdateTaskInput } from "./types/pm-task.schema";

/**
 * The Tasks client orchestrator.
 *
 * It owns the page's interaction state — the search box, the three catalog-driven filters, the root
 * page number and the background-refresh flag — and composes the three hooks that carry the data:
 * `useTasks` (rows, catalogs, capabilities), `useAssignees` (the member directory that names the
 * assignees) and `useTaskTree` (the assembled forest plus expand/collapse state).
 *
 * Responsibilities that deliberately live elsewhere:
 * - **Dialogs** are `TaskFormDialog` (create and edit), `SubtaskCreateDialog` (create under a parent)
 *   and `TaskDetailSheet` (read view with the edit / add-sub-task / delete actions). This module owns
 *   only their open state and the callbacks they call, so the toolbar's `onCreateTask` contract stays
 *   a plain "open the create dialog".
 * - **Drag-and-drop persistence** is a thin adapter here: `TreeDndProvider` resolves the pinned
 *   `{ parent_id, sibling_ids }` payload and this module hands the moved id plus that payload to
 *   `useTaskMutations().moveTask`, which performs the write and the mandatory refetch.
 *
 * Filtering follows the pinned semantics: the pagination unit is the ROOT task (a root's whole
 * subtree renders with it), a filter/search never orphans a child (an ancestor of a match stays
 * visible), any filter/search change resets to page 1, page numbers clamp when the set shrinks, and
 * the pager renders nothing on a single page. Filters are client-side over the department's
 * already-fetched set; the department identity scoping happened server-side.
 *
 * Capabilities are never computed here: `capabilities` comes off the route payload and is handed
 * straight to the header actions and the dialogs, which are the only things that decide which
 * actions to mount. The one exception the payload does not answer is per-row delete, and that
 * answer is the row's own server-computed `can_delete` — never a session flag, never an id comparison.
 */

/** Root tasks per page — the pagination unit is a root task, never a nested row. */
const PAGE_SIZE = 10;

/** A catalog label is DATA; an option with a blank label still counts as a filter choice. */
interface TaskFilterState {
    readonly search: string;
    readonly statusId: number | null;
    readonly priorityId: number | null;
    readonly assigneeId: number | null;
    /** The "filter by field" clause: a column key plus the value to match. */
    readonly fieldFilter: FieldFilterClause;
}

/** Case- and whitespace-insensitive search term, used for the match and the empty copy. */
function normaliseSearch(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Does one row satisfy the "filter by field" clause?
 *
 * The clause is a filter only when the field is picked AND its value is non-blank, so choosing a
 * column alone never drops a row. A custom answer is read as `find(...)?.value ?? null` because a
 * column with NO answer is ABSENT from `custom_values`, not present-with-null.
 *
 * Matching is by the STORED string, which is the same rule the server writes and the row badge
 * resolves: a Choice answer is a single option id, so `String(id) === value` — never a label, which
 * would silently miss a choice whose option was soft-deleted. `text` is a trimmed, case-insensitive
 * substring; `number` compares against `String(Number(value))` (the shape it is stored in); `date`
 * and `select` are exact.
 */
function matchesFieldClause(
    row: TaskTreeRow,
    clause: FieldFilterClause,
    fields: readonly TaskField[],
): boolean {
    const { fieldKey, value } = clause;
    if (fieldKey === null || value === null) return true;
    const needle = value.trim();
    if (needle === "") return true;

    if (fieldKey === STATUS_FIELD_KEY) return String(row.status_id) === value;
    if (fieldKey === PRIORITY_FIELD_KEY) return String(row.priority_id) === value;

    const fieldId = customFieldIdFromKey(fieldKey);
    if (fieldId === null) return true;

    const stored = row.custom_values.find((entry) => entry.field_id === fieldId)?.value ?? null;
    if (stored === null || stored === "") return false;

    switch (fields.find((field) => field.id === fieldId)?.field_type) {
        case "number": {
            const parsed = Number(needle);
            return Number.isFinite(parsed) && stored === String(parsed);
        }
        case "date":
        case "select":
            return stored === value;
        default:
            return stored.trim().toLowerCase().includes(needle.toLowerCase());
    }
}

/** Does one row satisfy the active search and filters? */
function rowMatches(
    row: TaskTreeRow,
    filters: TaskFilterState,
    fields: readonly TaskField[],
): boolean {
    const search = normaliseSearch(filters.search);
    if (search !== "" && !row.title.toLowerCase().includes(search)) return false;
    if (filters.statusId !== null && row.status_id !== filters.statusId) return false;
    if (filters.priorityId !== null && row.priority_id !== filters.priorityId) return false;
    if (
        filters.assigneeId !== null &&
        !row.assignees.some((assignee) => assignee.user_id === filters.assigneeId)
    ) {
        return false;
    }
    return matchesFieldClause(row, filters.fieldFilter, fields);
}

/**
 * Prunes the forest to the matching rows while keeping every ancestor of a match.
 *
 * A root that does not match but owns a matching descendant is still returned (with only the
 * matching branches beneath it), which is what stops a filter from orphaning a child. The returned
 * nodes are copies so the source forest stays untouched; `depth` and `children` are carried over.
 */
function filterTree(
    nodes: readonly TreeNode<TaskTreeRow>[],
    filters: TaskFilterState,
    fields: readonly TaskField[],
): TreeNode<TaskTreeRow>[] {
    const kept: TreeNode<TaskTreeRow>[] = [];

    for (const node of nodes) {
        const children = filterTree(node.children, filters, fields);
        const isMatch = rowMatches(node, filters, fields);
        if (isMatch || children.length > 0) kept.push({ ...node, children });
    }
    return kept;
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
    return option === undefined ? null : { label: option.label, color: option.color };
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

/** Stable row renderer: the sortable wrapper the dnd engine needs, defined once. */
function SortableRow(props: TaskRowProps) {
    return <SortableTaskRow {...props} />;
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
    const { items, catalogs, fields, isLoading, isRefreshing, error, capabilities, refresh } = useTasks();
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
        moveTask,
        uploadAttachment,
        detachAttachment,
        clearError,
    } = useTaskMutations({ onChanged: refresh });
    const { roots, expandedIds, toggleExpand } = useTaskTree(items, memberNameById);

    const [search, setSearch] = useState("");
    const [statusId, setStatusId] = useState<number | null>(null);
    const [priorityId, setPriorityId] = useState<number | null>(null);
    const [assigneeId, setAssigneeId] = useState<number | null>(null);
    const [fieldFilter, setFieldFilter] = useState<FieldFilterClause>(NO_FIELD_FILTER);
    const [page, setPage] = useState(1);

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

    const isFiltering =
        normaliseSearch(search) !== "" ||
        statusId !== null ||
        priorityId !== null ||
        assigneeId !== null ||
        isFieldFilterActive(fieldFilter);

    const filteredRoots = useMemo(
        () => filterTree(roots, { search, statusId, priorityId, assigneeId, fieldFilter }, fields),
        [roots, search, statusId, priorityId, assigneeId, fieldFilter, fields],
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

    const totalPages = Math.max(1, Math.ceil(filteredRoots.length / PAGE_SIZE));
    const currentPage = Math.min(page, totalPages);

    // The pagination unit is a root task, so the slice is taken over roots and never over the
    // flattened subtree — a root and all of its descendants always render on the same page.
    const pagedRoots = useMemo(
        () => filteredRoots.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
        [filteredRoots, currentPage],
    );

    const handleSearchChange = useCallback((value: string) => {
        setSearch(value);
        setPage(1);
    }, []);

    const handleStatusFilterChange = useCallback((value: number | null) => {
        setStatusId(value);
        setPage(1);
    }, []);

    const handlePriorityFilterChange = useCallback((value: number | null) => {
        setPriorityId(value);
        setPage(1);
    }, []);

    const handleAssigneeFilterChange = useCallback((value: number | null) => {
        setAssigneeId(value);
        setPage(1);
    }, []);

    const handleFieldFilterChange = useCallback((next: FieldFilterClause) => {
        setFieldFilter(next);
        setPage(1);
    }, []);

    const handleClearFilters = useCallback(() => {
        setSearch("");
        setStatusId(null);
        setPriorityId(null);
        setAssigneeId(null);
        setFieldFilter(NO_FIELD_FILTER);
        setPage(1);
    }, []);

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
     * The create seam the toolbar calls. Landing the dialog changes nothing about that contract: it
     * still just opens the create form.
     */
    const handleCreateTask = useCallback((): void => {
        setIsCreateOpen(true);
    }, []);

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

    const handleTreeMove = useCallback(
        (activeId: number, payload: MoveTaskInput): void => {
            void moveTask(activeId, payload);
        },
        [moveTask],
    );

    /** Opens a cell editor, unless that cell already has a save in flight. */
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
     * The per-row actions the tree renders: open the detail sheet. Re-parenting is drag-and-drop
     * only, so the drag handle — not a row action — is the move affordance; it is disabled while a
     * filter is active because the reorder contract is defined over the destination parent's complete
     * child list, which a filtered view does not show.
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

    return (
        <section
            data-slot="tasks-module"
            className="mx-auto w-full max-w-7xl scroll-pt-16 space-y-4 px-4 py-6 md:scroll-pt-20"
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                    <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>
                    <p className="max-w-prose text-sm text-muted-foreground">
                        Your department&apos;s tasks. Break work into as many sub-tasks as you need, assign
                        colleagues and track status and due dates.
                    </p>
                </div>

                <TasksHeaderActions capabilities={capabilities} onCreateTask={handleCreateTask} />
            </div>

            <TasksViewTabs value={view} onValueChange={setView} />

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
                statusFilter={statusId}
                onStatusFilterChange={handleStatusFilterChange}
                priorityFilter={priorityId}
                onPriorityFilterChange={handlePriorityFilterChange}
                assigneeFilter={assigneeId}
                onAssigneeFilterChange={handleAssigneeFilterChange}
                fieldFilter={fieldFilter}
                onFieldFilterChange={handleFieldFilterChange}
                fields={fields}
                statuses={catalogs.statuses}
                priorities={catalogs.priorities}
                members={members}
                currentUserId={userId}
                isFiltering={isFiltering}
                onClearFilters={handleClearFilters}
                isRefreshing={isRefreshing}
                onRefresh={handleRefresh}
            />

            {/*
             * A drop persists through `onMove` → `moveTask` → refetch. Reordering is disabled while
             * a filter or search is active, because the ordering contract is defined over the
             * destination parent's COMPLETE child list, which a filtered view does not show.
             */}
            <TreeDndProvider
                roots={pagedRoots}
                expandedIds={renderExpandedIds}
                allRows={items}
                reorderDisabled={isFiltering}
                onMove={handleTreeMove}
            >
                <TaskTree
                    roots={pagedRoots}
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
                    renderRow={SortableRow}
                    renderActions={renderRowActions}
                    aria-label="Task list"
                />
            </TreeDndProvider>

            {totalPages > 1 ? (
                <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
                    <p className="text-xs text-muted-foreground">
                        Page {currentPage} of {totalPages}
                        {" · "}
                        {filteredRoots.length} top-level task{filteredRoots.length === 1 ? "" : "s"}
                    </p>

                    <Pagination className="mx-0 w-auto">
                        <PaginationContent>
                            <PaginationItem>
                                <PaginationPrevious
                                    href="#"
                                    aria-disabled={currentPage <= 1}
                                    className={currentPage <= 1 ? "pointer-events-none opacity-50" : undefined}
                                    onClick={(event) => {
                                        event.preventDefault();
                                        handlePageChange(currentPage - 1);
                                    }}
                                />
                            </PaginationItem>
                            <PaginationItem>
                                <PaginationLink
                                    href="#"
                                    isActive
                                    aria-label={`Page ${currentPage}`}
                                    onClick={(event) => event.preventDefault()}
                                >
                                    {currentPage}
                                </PaginationLink>
                            </PaginationItem>
                            <PaginationItem>
                                <PaginationNext
                                    href="#"
                                    aria-disabled={currentPage >= totalPages}
                                    className={
                                        currentPage >= totalPages ? "pointer-events-none opacity-50" : undefined
                                    }
                                    onClick={(event) => {
                                        event.preventDefault();
                                        handlePageChange(currentPage + 1);
                                    }}
                                />
                            </PaginationItem>
                        </PaginationContent>
                    </Pagination>
                </div>
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
                onCreate={createTask}
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
                onCreate={createTask}
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
                onCreate={createTask}
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

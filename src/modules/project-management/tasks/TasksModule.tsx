"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, CornerDownRight, Eye, RotateCcw } from "lucide-react";

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

import { MoveToParentDialog } from "./components/tree-dnd/MoveToParentDialog";
import { SortableTaskRow } from "./components/tree-dnd/SortableTaskRow";
import { TreeDndProvider } from "./components/tree-dnd/TreeDndProvider";
import { SubtaskCreateDialog } from "./components/SubtaskCreateDialog";
import { TaskDetailSheet } from "./components/TaskDetailSheet";
import { TaskFormDialog, type TaskBreadcrumb } from "./components/TaskFormDialog";
import { TaskTree } from "./components/TaskTree";
import { TasksToolbar } from "./components/TasksToolbar";
import type { TaskRowProps, TaskRowView } from "./components/TaskRow";
import { useAssignees } from "./hooks/useAssignees";
import { useTasks, type TaskListItem } from "./hooks/useTasks";
import { useTaskMutations } from "./hooks/useTaskMutations";
import { useTaskTree, type TaskTreeRow } from "./hooks/useTaskTree";
import type { MoveTaskInput } from "./types/pm-task.schema";

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
 * straight to the toolbar and the dialogs, which are the only things that decide which actions to
 * mount. The one exception the payload does not answer is per-row delete, and that answer is the
 * row's own server-computed `can_delete` — never a session flag, never an id comparison.
 */

/** Root tasks per page — the pagination unit is a root task, never a nested row. */
const PAGE_SIZE = 10;

/** A catalog label is DATA; an option with a blank label still counts as a filter choice. */
interface TaskFilterState {
    readonly search: string;
    readonly statusId: number | null;
    readonly priorityId: number | null;
    readonly assigneeId: number | null;
}

/** Case- and whitespace-insensitive search term, used for the match and the empty copy. */
function normaliseSearch(value: string): string {
    return value.trim().toLowerCase();
}

/** Does one row satisfy the active search and filters? */
function rowMatches(
    row: TaskTreeRow,
    search: string,
    statusId: number | null,
    priorityId: number | null,
    assigneeId: number | null,
): boolean {
    if (search !== "" && !row.title.toLowerCase().includes(search)) return false;
    if (statusId !== null && row.status_id !== statusId) return false;
    if (priorityId !== null && row.priority_id !== priorityId) return false;
    if (assigneeId !== null && !row.assignees.some((assignee) => assignee.user_id === assigneeId)) {
        return false;
    }
    return true;
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
): TreeNode<TaskTreeRow>[] {
    const kept: TreeNode<TaskTreeRow>[] = [];
    const search = normaliseSearch(filters.search);

    for (const node of nodes) {
        const children = filterTree(node.children, filters);
        const isMatch = rowMatches(node, search, filters.statusId, filters.priorityId, filters.assigneeId);
        if (isMatch || children.length > 0) kept.push({ ...node, children });
    }
    return kept;
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
    const { items, catalogs, isLoading, isRefreshing, error, capabilities, refresh } = useTasks();
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
        clearError,
    } = useTaskMutations({ onChanged: refresh });
    const { roots, expandedIds, toggleExpand } = useTaskTree(items, memberNameById);

    const [search, setSearch] = useState("");
    const [statusId, setStatusId] = useState<number | null>(null);
    const [priorityId, setPriorityId] = useState<number | null>(null);
    const [assigneeId, setAssigneeId] = useState<number | null>(null);
    const [page, setPage] = useState(1);

    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
    const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
    const [subtaskParentId, setSubtaskParentId] = useState<number | null>(null);
    const [movingTaskId, setMovingTaskId] = useState<number | null>(null);

    const isDialogSubmitting = isTaskSubmitting || isAssigneeSubmitting;

    const taskById = useMemo(() => {
        const map = new Map<number, TaskListItem>();
        for (const item of items) map.set(item.id, item);
        return map;
    }, [items]);

    const detailTask = detailTaskId === null ? null : (taskById.get(detailTaskId) ?? null);
    const editingTask = editingTaskId === null ? null : (taskById.get(editingTaskId) ?? null);
    const subtaskParent = subtaskParentId === null ? null : (taskById.get(subtaskParentId) ?? null);

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
        normaliseSearch(search) !== "" || statusId !== null || priorityId !== null || assigneeId !== null;

    const filteredRoots = useMemo(
        () => filterTree(roots, { search, statusId, priorityId, assigneeId }),
        [roots, search, statusId, priorityId, assigneeId],
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

    const handleClearFilters = useCallback(() => {
        setSearch("");
        setStatusId(null);
        setPriorityId(null);
        setAssigneeId(null);
        setPage(1);
    }, []);

    const handleRefresh = useCallback(() => {
        void refresh();
    }, [refresh]);

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

    const handleMoveOpenChange = useCallback((next: boolean): void => {
        if (!next) setMovingTaskId(null);
    }, []);

    const getTaskLabel = useCallback(
        (id: number): string => taskById.get(id)?.title ?? `Task #${id}`,
        [taskById],
    );

    const handleMoveToSubmit = useCallback(
        async (payload: MoveTaskInput): Promise<void> => {
            if (movingTaskId === null) return;
            const moved = await moveTask(movingTaskId, payload);
            if (moved) setMovingTaskId(null);
        },
        [movingTaskId, moveTask],
    );

    /**
     * The per-row actions the tree renders: open the detail sheet, or open the keyboard-accessible
     * "Move to…" picker. The move action stays enabled while a filter is active — only the drag
     * handle is disabled, because the reorder contract is defined over the destination parent's
     * complete child list, which a filtered view does not show.
     */
    const renderRowActions = useCallback((node: TreeNode<TaskRowView>) => {
        const detailsLabel = `View details for ${node.title}`;
        const moveLabel = `Move ${node.title} to another parent`;
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
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={moveLabel}
                    title={moveLabel}
                    data-slot="task-row-move"
                    onClick={() => setMovingTaskId(node.id)}
                >
                    <CornerDownRight className="size-4" aria-hidden="true" />
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
        <section data-slot="tasks-module" className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6">
            <div className="space-y-1">
                <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>
                <p className="text-sm text-muted-foreground">
                    Your department&apos;s tasks. Break work into as many sub-tasks as you need, assign
                    colleagues and track status and due dates.
                </p>
            </div>

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
                statuses={catalogs.statuses}
                priorities={catalogs.priorities}
                members={members}
                currentUserId={userId}
                isFiltering={isFiltering}
                onClearFilters={handleClearFilters}
                isRefreshing={isRefreshing}
                onRefresh={handleRefresh}
                capabilities={capabilities}
                onCreateTask={handleCreateTask}
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

            <MoveToParentDialog
                open={movingTaskId !== null}
                onOpenChange={handleMoveOpenChange}
                activeId={movingTaskId}
                rows={items}
                getLabel={getTaskLabel}
                onSubmit={handleMoveToSubmit}
                isSubmitting={isTaskSubmitting}
            />

            <TaskDetailSheet
                open={detailTaskId !== null}
                onOpenChange={handleDetailOpenChange}
                task={detailTask}
                parentTrail={detailTrail}
                childCount={detailTaskId === null ? 0 : (childCountById.get(detailTaskId) ?? 0)}
                memberNameById={memberNameById}
                capabilities={capabilities}
                isSubmitting={isDialogSubmitting}
                onEdit={handleEditDetail}
                onAddSubtask={handleAddSubtask}
                onDelete={handleDeleteTask}
            />
        </section>
    );
}

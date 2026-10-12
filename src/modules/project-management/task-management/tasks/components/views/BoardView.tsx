"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    DndContext,
    DragOverlay,
    MouseSensor,
    TouchSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type Announcements,
    type DragEndEvent,
    type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { LayoutGrid, RotateCcw, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CatalogChipDot } from "../CatalogChip";

import { assigneeName, type TaskViewProps } from "../../types/task-view";
import type { TaskListItem } from "../../hooks/useTasks";
import { AssigneeFilterCombobox, filterItemsByAssignees } from "../AssigneeFilterCombobox";import { AssigneeStack, type TaskAssigneeView } from "../AssigneeStack";
import { CatalogStatusIcon } from "../CatalogStatusIcon";
import { TaskCombobox } from "../TaskCombobox";
import { formatTaskDateRange } from "../TaskRow";
import { TaskPriorityBadge } from "../TaskRowBadges";
import {
    BOARD_DEFAULT_GROUP_ID,
    boardGroupDimensions,
    findBoardGroupDimension,
    groupBoardItems,
    type BoardDropTarget,
    type BoardGroupColumn,
    type BoardGroupDirection,
} from "../board-group";
import type { CellEditRequest } from "../TaskCellEditor";

/** Kanban board of the department's tasks, grouped by a chosen dimension. */
export function BoardView({
    items,
    catalogs,
    fields,
    memberNameById,
    isLoading,
    error,
    onRetry,
    onOpenTask,
    onCellCommit,
}: TaskViewProps) {
    const [groupId, setGroupId] = useState<string>(BOARD_DEFAULT_GROUP_ID);
    const [direction, setDirection] = useState<BoardGroupDirection>("asc");
    const [assigneeFilter, setAssigneeFilter] = useState<readonly string[]>([]);
    const [pendingByTask, setPendingByTask] = useState<ReadonlyMap<number, BoardDropTarget>>(
        () => new Map(),
    );
    const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
    const pendingTimeouts = useRef(new Map<number, ReturnType<typeof setTimeout>>());

    /*
     * Two sensors, not one `PointerSensor`: a finger needs a press-and-hold, because with a
     * distance-only constraint a swipe would lift the card instead of scrolling the column.
     */
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    );

    const groupOptions = useMemo(
        () =>
            boardGroupDimensions(fields).map((dimension) => ({
                value: dimension.id,
                label: dimension.label,
            })),
        [fields],
    );

    // A custom column can vanish between refetches; fall back rather than point at a dead axis.
    const effectiveGroupId =
        findBoardGroupDimension(groupId, fields) === null ? BOARD_DEFAULT_GROUP_ID : groupId;

    const boardKey = useMemo(() => {
        if (onCellCommit === undefined) return null;
        if (effectiveGroupId === "status") return "board:status";
        if (effectiveGroupId === "priority") return "board:priority";
        if (effectiveGroupId.startsWith("field:")) {
            const fieldId = Number(effectiveGroupId.slice("field:".length));
            const field = fields.find((candidate) => candidate.id === fieldId) ?? null;
            return field !== null && field.field_type === "select"
                ? `board:field:${field.id}`
                : null;
        }
        return null;
    }, [onCellCommit, effectiveGroupId, fields]);
    const dragEnabled = boardKey !== null;

    const liveById = useMemo(() => {
        const byId = new Map<number, TaskListItem>();
        for (const task of items) byId.set(task.id, task);
        return byId;
    }, [items]);

    const activePending = useMemo(() => {
        if (pendingByTask.size === 0) return pendingByTask;
        let pruned: Map<number, BoardDropTarget> | null = null;
        for (const [taskId, target] of pendingByTask) {
            const live = liveById.get(taskId);
            if (live !== undefined && targetReached(live, target)) {
                if (pruned === null) pruned = new Map(pendingByTask);
                pruned.delete(taskId);
            }
        }
        return pruned ?? pendingByTask;
    }, [pendingByTask, liveById]);

    useEffect(() => {
        const timeouts = pendingTimeouts.current;
        return () => {
            for (const timeout of timeouts.values()) clearTimeout(timeout);
            timeouts.clear();
        };
    }, []);

    const displayItems = useMemo(() => {
        if (activePending.size === 0) return items;
        return items.map((item) => {
            const target = activePending.get(item.id);
            return target === undefined ? item : applyPendingTarget(item, target);
        });
    }, [items, activePending]);

    const visibleItems = useMemo(
        () => filterItemsByAssignees(displayItems, assigneeFilter),
        [displayItems, assigneeFilter],
    );

    const columns = useMemo(
        () =>
            groupBoardItems(visibleItems, effectiveGroupId, direction, {
                catalogs,
                fields,
                memberNameById,
            }),
        [visibleItems, effectiveGroupId, direction, catalogs, fields, memberNameById],
    );

    const tasksById = useMemo(() => {
        const byId = new Map<number, TaskListItem>();
        for (const task of displayItems) byId.set(task.id, task);
        return byId;
    }, [displayItems]);

    const columnLabelByKey = useMemo(
        () => new Map(columns.map((column) => [column.key, column.label] as const)),
        [columns],
    );

    const announcements = useMemo<Announcements>(
        () => ({
            onDragStart({ active }) {
                const task = tasksById.get(dragTaskIdOf(active.id) ?? -1);
                return task === undefined ? undefined : `Picked up ${task.title}.`;
            },
            onDragOver({ over }) {
                if (over === null) return undefined;
                const label = columnLabelByKey.get(String(over.id));
                return label === undefined ? undefined : `Moving over ${label}.`;
            },
            onDragEnd({ active, over }) {
                const task = tasksById.get(dragTaskIdOf(active.id) ?? -1);
                if (over === null) {
                    return task === undefined
                        ? undefined
                        : `Drag cancelled. ${task.title} was not moved.`;
                }
                const label = columnLabelByKey.get(String(over.id));
                return task === undefined || label === undefined
                    ? undefined
                    : `Moved ${task.title} to ${label}.`;
            },
            onDragCancel({ active }) {
                const task = tasksById.get(dragTaskIdOf(active.id) ?? -1);
                return task === undefined ? undefined : `Drag cancelled. ${task.title} was not moved.`;
            },
        }),
        [tasksById, columnLabelByKey],
    );

    const handleDragStart = (event: DragStartEvent) => {
        setActiveTaskId(dragTaskIdOf(event.active.id));
    };

    const handleDragCancel = () => {
        setActiveTaskId(null);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        setActiveTaskId(null);
        const taskId = dragTaskIdOf(event.active.id);
        const overKey = event.over === null ? null : String(event.over.id);
        if (taskId === null || overKey === null) return;
        const drop = columns.find((column) => column.key === overKey)?.drop ?? null;
        if (drop === null || onCellCommit === undefined || boardKey === null) return;
        const live = liveById.get(taskId);
        if (live === undefined || !live.can_edit || targetReached(live, drop)) return;
        setPendingByTask((previous) => new Map(previous).set(taskId, drop));
        const existing = pendingTimeouts.current.get(taskId);
        if (existing !== undefined) clearTimeout(existing);
        const timeout = setTimeout(() => {
            pendingTimeouts.current.delete(taskId);
            setPendingByTask((previous) => {
                if (!previous.has(taskId)) return previous;
                const next = new Map(previous);
                next.delete(taskId);
                return next;
            });
        }, PENDING_TTL_MS);
        pendingTimeouts.current.set(taskId, timeout);
        onCellCommit(taskId, boardKey, requestOfDrop(drop));
    };

    const showError = error !== null && error !== "";
    const isEmpty = !isLoading && !showError && items.length === 0;
    const isFilteredEmpty = !isEmpty && visibleItems.length === 0;

    if (isLoading) return <BoardSkeleton />;

    if (showError) {
        return (
            <BoardStatePanel
                icon={<TriangleAlert className="size-8 text-destructive" aria-hidden="true" />}
                message={error}
                isAlert
                onRetry={onRetry}
            />
        );
    }

    if (isEmpty) {
        return (
            <BoardStatePanel
                icon={<LayoutGrid className="size-8 text-muted-foreground/50" aria-hidden="true" />}
                message="No tasks in this list yet."
            />
        );
    }

    const overlayTask = activeTaskId === null ? null : (tasksById.get(activeTaskId) ?? null);
    const overlayParentTitle =
        overlayTask === null || overlayTask.parent_id === null
            ? null
            : (tasksById.get(overlayTask.parent_id)?.title ?? null);

    const boardContent = isFilteredEmpty ? (
        <p
            data-slot="task-board-filtered-empty"
            className="rounded-2xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground"
        >
            No task is assigned to the selected people.
        </p>
    ) : (
        <div data-slot="task-board-scroller" className="flex w-full gap-4 overflow-x-auto pb-2">
            {columns.map((column) => (
                <BoardColumn
                    key={column.key}
                    column={column}
                    tasksById={tasksById}
                    memberNameById={memberNameById}
                    dragEnabled={dragEnabled}
                    onOpenTask={onOpenTask}
                />
            ))}
        </div>
    );

    return (
        <div data-slot="task-board" className="w-full min-w-0">
            <div data-slot="task-board-group-bar" className="mb-4 flex flex-wrap items-end gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">Group by</span>
                    <TaskCombobox
                        className="w-56"
                        options={groupOptions}
                        value={effectiveGroupId}
                        onValueChange={(next) => {
                            if (next !== null) setGroupId(next);
                        }}
                        ariaLabel="Group by"
                        searchPlaceholder="Search fields..."
                        emptyMessage="No fields match."
                        clearable={false}
                        showStatusIcon={false}
                    />
                </div>

                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">Order</span>
                    <Select
                        value={direction}
                        onValueChange={(next) => setDirection(toDirection(next))}
                    >
                        <SelectTrigger className="w-36" aria-label="Group order">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="asc">Ascending</SelectItem>
                            <SelectItem value="desc">Descending</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <AssigneeFilterCombobox
                    items={items}
                    memberNameById={memberNameById}
                    values={assigneeFilter}
                    onValuesChange={setAssigneeFilter}
                    className="ml-auto sm:w-fit"
                />
            </div>

            {dragEnabled ? (
                <DndContext
                    sensors={sensors}
                    accessibility={{ announcements }}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragCancel={handleDragCancel}
                >
                    {boardContent}
                    <DragOverlay>
                        {overlayTask === null ? null : (
                            <article
                                aria-hidden="true"
                                className="rounded-2xl border border-border/50 bg-card p-3 shadow-lg"
                            >
                                <BoardCardBody
                                    task={overlayTask}
                                    parentTitle={overlayParentTitle}
                                    memberNameById={memberNameById}
                                />
                            </article>
                        )}
                    </DragOverlay>
                </DndContext>
            ) : (
                boardContent
            )}
        </div>
    );
}

/** The direction a Select reported, narrowed to the two the control offers. */
function toDirection(value: string): BoardGroupDirection {
    return value === "desc" ? "desc" : "asc";
}

const DRAG_CARD_PREFIX = "board-task:";

/** A failed write must not leave a card stuck in the wrong column. */
const PENDING_TTL_MS = 5000;

function dragCardId(taskId: number): string {
    return `${DRAG_CARD_PREFIX}${taskId}`;
}

function dragTaskIdOf(id: string | number): number | null {
    const text = String(id);
    if (!text.startsWith(DRAG_CARD_PREFIX)) return null;
    const parsed = Number(text.slice(DRAG_CARD_PREFIX.length));
    return Number.isInteger(parsed) ? parsed : null;
}

/** Whether the live row already carries the drop's value, so a same-column drop writes nothing. */
function targetReached(task: TaskListItem, target: BoardDropTarget): boolean {
    switch (target.kind) {
        case "status":
            return task.status_id === target.statusId;
        case "priority":
            return task.priority_id === target.priorityId;
        case "field": {
            const stored =
                task.custom_values.find((value) => value.field_id === target.fieldId)?.value ??
                null;
            return (stored === null || stored === "" ? null : stored) === target.value;
        }
    }
}

/** A row copy carrying the pending target, so the card moves before the refetch lands. */
function applyPendingTarget(task: TaskListItem, target: BoardDropTarget): TaskListItem {
    switch (target.kind) {
        case "status":
            return { ...task, status_id: target.statusId };
        case "priority":
            return { ...task, priority_id: target.priorityId };
        case "field":
            return {
                ...task,
                custom_values: [
                    ...task.custom_values.filter((value) => value.field_id !== target.fieldId),
                    { field_id: target.fieldId, value: target.value },
                ],
            };
    }
}

function requestOfDrop(target: BoardDropTarget): CellEditRequest {
    switch (target.kind) {
        case "status":
            return { kind: "status", id: target.statusId };
        case "priority":
            return { kind: "priority", id: target.priorityId };
        case "field":
            return { kind: "field", fieldId: target.fieldId, value: target.value };
    }
}

interface BoardColumnProps {
    column: BoardGroupColumn;
    tasksById: ReadonlyMap<number, TaskListItem>;
    memberNameById: ReadonlyMap<number, string>;
    dragEnabled: boolean;
    onOpenTask?: (taskId: number) => void;
}

/** Cards painted per column before offering "Show more". */
const INITIAL_VISIBLE_CARDS = 20;

/** One group column. */
function BoardColumn({ column, tasksById, memberNameById, dragEnabled, onOpenTask }: BoardColumnProps) {
    const [showAllCards, setShowAllCards] = useState(false);
    const { setNodeRef, isOver } = useDroppable({
        id: column.key,
        disabled: !dragEnabled || column.drop === null,
    });
    const { cards } = column;
    const countLabel = `${cards.length} task${cards.length === 1 ? "" : "s"}`;
    const hiddenCount = cards.length - INITIAL_VISIBLE_CARDS;
    const visibleCards = showAllCards ? cards : cards.slice(0, INITIAL_VISIBLE_CARDS);
    const highlighted = dragEnabled && column.drop !== null && isOver;

    return (
        <section
            ref={setNodeRef}
            data-slot="task-board-column"
            data-group-key={column.key}
            aria-label={column.label}
            className={cn(
                "flex max-h-[70vh] w-72 shrink-0 flex-col gap-3 rounded-2xl border border-border/50 bg-muted/30 p-3",
                highlighted && "border-primary bg-primary/5 ring-2 ring-primary/40",
            )}
        >
            <header className="flex shrink-0 items-center justify-between gap-2">
                <h3 className="flex min-w-0 items-center gap-2">
                    {column.icon === null ? (
                        <CatalogChipDot color={column.color} density="comfortable" />
                    ) : (
                        <CatalogStatusIcon
                            icon={column.icon}
                            color={column.color}
                            tone="status"
                            density="comfortable"
                        />
                    )}
                    <span className="truncate text-sm font-semibold" title={column.label}>
                        {column.label}
                    </span>
                </h3>
                <Badge
                    variant="secondary"
                    data-slot="task-board-column-count"
                    title={countLabel}
                    className="shrink-0 border-border/60 px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground"
                >
                    <span aria-hidden="true">{cards.length}</span>
                    <span className="sr-only">{countLabel}</span>
                </Badge>
            </header>

            {cards.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                    Nothing here
                </p>
            ) : (
                <div
                    data-slot="task-board-card-list"
                    // min-h-0 lets the list shrink and scroll inside the capped column.
                    className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain"
                >
                    {visibleCards.map((task) =>
                        dragEnabled ? (
                            <DraggableBoardCard
                                key={task.id}
                                task={task}
                                parentTitle={
                                    task.parent_id === null
                                        ? null
                                        : (tasksById.get(task.parent_id)?.title ?? null)
                                }
                                memberNameById={memberNameById}
                                onOpenTask={onOpenTask}
                            />
                        ) : (
                            <BoardCard
                                key={task.id}
                                task={task}
                                parentTitle={
                                    task.parent_id === null
                                        ? null
                                        : (tasksById.get(task.parent_id)?.title ?? null)
                                }
                                memberNameById={memberNameById}
                                onOpenTask={onOpenTask}
                            />
                        ),
                    )}

                    {hiddenCount > 0 && !showAllCards && (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-slot="task-board-show-more"
                            onClick={() => setShowAllCards(true)}
                        >
                            Show {hiddenCount} more
                        </Button>
                    )}
                </div>
            )}
        </section>
    );
}

interface BoardCardProps {
    task: TaskListItem;
    /** The parent's title, or `null` when the task is a root or its parent is not in the row set. */
    parentTitle: string | null;
    memberNameById: ReadonlyMap<number, string>;
    onOpenTask?: (taskId: number) => void;
}

/** One task as a board card. */
function BoardCard({ task, parentTitle, memberNameById, onOpenTask }: BoardCardProps) {
    const interactive = onOpenTask !== undefined;

    return (
        <article
            data-slot="task-board-card"
            data-task-id={task.id}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? `Open ${task.title}` : undefined}
            onClick={interactive ? () => onOpenTask(task.id) : undefined}
            onKeyDown={
                interactive
                    ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onOpenTask(task.id);
                          }
                      }
                    : undefined
            }
            className={cn(
                "rounded-2xl border border-border/50 bg-card p-3 shadow-sm",
                interactive &&
                    "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            )}
        >
            <BoardCardBody
                task={task}
                parentTitle={parentTitle}
                memberNameById={memberNameById}
            />
        </article>
    );
}

/** The same card as a drag source; a `can_edit === false` row renders but never lifts. */
function DraggableBoardCard({ task, parentTitle, memberNameById, onOpenTask }: BoardCardProps) {
    const interactive = onOpenTask !== undefined;
    const { listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: dragCardId(task.id),
        disabled: !task.can_edit,
    });
    const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

    return (
        <article
            ref={setNodeRef}
            style={style}
            {...listeners}
            data-slot="task-board-card"
            data-task-id={task.id}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? `Open ${task.title}` : undefined}
            onClick={interactive ? () => onOpenTask(task.id) : undefined}
            onKeyDown={
                interactive
                    ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onOpenTask(task.id);
                          }
                      }
                    : undefined
            }
            className={cn(
                "rounded-2xl border border-border/50 bg-card p-3 shadow-sm",
                interactive &&
                    "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isDragging && "opacity-40",
            )}
        >
            <BoardCardBody
                task={task}
                parentTitle={parentTitle}
                memberNameById={memberNameById}
            />
        </article>
    );
}

interface BoardCardBodyProps {
    task: TaskListItem;
    parentTitle: string | null;
    memberNameById: ReadonlyMap<number, string>;
}

/** The card's painted content, shared by the card, its drag source and its overlay. */
function BoardCardBody({ task, parentTitle, memberNameById }: BoardCardBodyProps) {
    const assignees: TaskAssigneeView[] = task.assignees.map((assignee) => ({
        user_id: assignee.user_id,
        full_name: assigneeName(assignee.user_id, memberNameById),
    }));
    const rangeText = formatTaskDateRange(task.start_date, task.end_date);

    return (
        <>
            <p className="truncate text-sm font-medium" title={task.title}>
                {task.title}
            </p>

            {parentTitle !== null && (
                <p className="mt-1 truncate text-xs text-muted-foreground" title={`in ${parentTitle}`}>
                    in {parentTitle}
                </p>
            )}

            <div className="mt-2 flex items-center gap-2">
                <TaskPriorityBadge priority={task.priority} />
                <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground" title={rangeText}>
                    {rangeText}
                </span>
            </div>

            <div className="mt-2">
                <AssigneeStack assignees={assignees} max={3} />
            </div>
        </>
    );
}

interface BoardStatePanelProps {
    icon: ReactNode;
    message: string;
    /** Error panels announce themselves; loading and empty panels are passive. */
    isAlert?: boolean;
    onRetry?: () => void;
}

/** Full-width state card for loading / empty / error. */
function BoardStatePanel({ icon, message, isAlert = false, onRetry }: BoardStatePanelProps) {
    return (
        <div
            data-slot="task-board-state-panel"
            className="flex h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
        >
            <div
                role={isAlert ? "alert" : undefined}
                className={cn("flex flex-col items-center justify-center gap-3", !isAlert && "gap-2")}
            >
                {icon}
                <p className="text-sm text-muted-foreground">{message}</p>
                {onRetry !== undefined && (
                    <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                        <RotateCcw className="size-4" aria-hidden="true" />
                        Try again
                    </Button>
                )}
            </div>
        </div>
    );
}

/** Cold-load skeleton shaped like the columns and cards. */
const SKELETON_COLUMNS: readonly string[] = ["one", "two", "three", "four"];
const SKELETON_CARDS: readonly string[] = ["one", "two", "three"];
function BoardSkeleton() {
    return (
        <div
            data-slot="task-board-loading"
            role="status"
            aria-label="Loading tasks"
            className="flex w-full gap-4 overflow-hidden pb-2"
        >
            {SKELETON_COLUMNS.map((column) => (
                <div
                    key={column}
                    className="flex w-72 shrink-0 flex-col gap-3 rounded-2xl border border-border/50 bg-muted/30 p-3"
                >
                    <div className="flex items-center justify-between gap-2">
                        <Skeleton className="h-5 w-28" />
                        <Skeleton className="h-5 w-6 rounded-full" />
                    </div>
                    {SKELETON_CARDS.map((card) => (
                        <Skeleton key={card} className="h-24 w-full rounded-2xl" />
                    ))}
                </div>
            ))}
            <span className="sr-only">Loading tasks…</span>
        </div>
    );
}

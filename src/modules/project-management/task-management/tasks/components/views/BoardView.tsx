"use client";

import { useMemo, useState, type ReactNode } from "react";
import { LayoutGrid, RotateCcw, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CatalogChipDot } from "../CatalogChip";

import { assigneeName, type TaskViewProps } from "../../types/task-view";
import type { TaskCatalogOption, TaskListItem } from "../../hooks/useTasks";
import { AssigneeStack, type TaskAssigneeView } from "../AssigneeStack";
import { formatTaskDateRange } from "../TaskRow";
import { TaskPriorityBadge } from "../TaskRowBadges";

/** Kanban board of the department's tasks, grouped by status catalog order. */
export function BoardView({
    items,
    catalogs,
    memberNameById,
    isLoading,
    error,
    onRetry,
}: TaskViewProps) {
    const tasksById = useMemo(() => {
        const byId = new Map<number, TaskListItem>();
        for (const task of items) byId.set(task.id, task);
        return byId;
    }, [items]);

    const cardsByStatusId = useMemo(() => {
        const grouped = new Map<number, TaskListItem[]>();
        for (const task of items) {
            const bucket = grouped.get(task.status_id);
            if (bucket === undefined) grouped.set(task.status_id, [task]);
            else bucket.push(task);
        }
        return grouped;
    }, [items]);

    const showError = error !== null && error !== "";
    const isEmpty = !isLoading && !showError && items.length === 0;

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

    return (
        <div data-slot="task-board" className="w-full min-w-0">
            <div
                data-slot="task-board-scroller"
                className="flex w-full gap-4 overflow-x-auto pb-2"
            >
                {catalogs.statuses.map((status) => (
                    <BoardColumn
                        key={status.id}
                        status={status}
                        cards={cardsByStatusId.get(status.id) ?? []}
                        tasksById={tasksById}
                        memberNameById={memberNameById}
                    />
                ))}
            </div>
        </div>
    );
}

interface BoardColumnProps {
    status: TaskCatalogOption;
    cards: readonly TaskListItem[];
    tasksById: ReadonlyMap<number, TaskListItem>;
    memberNameById: ReadonlyMap<number, string>;
}

/** Cards painted per column before offering "Show more". */
const INITIAL_VISIBLE_CARDS = 20;

/** One status column. */
function BoardColumn({ status, cards, tasksById, memberNameById }: BoardColumnProps) {
    const [showAllCards, setShowAllCards] = useState(false);
    const countLabel = `${cards.length} task${cards.length === 1 ? "" : "s"}`;
    const hiddenCount = cards.length - INITIAL_VISIBLE_CARDS;
    const visibleCards = showAllCards ? cards : cards.slice(0, INITIAL_VISIBLE_CARDS);

    return (
        <section
            data-slot="task-board-column"
            data-status-id={status.id}
            aria-label={status.label}
            className="flex max-h-[70vh] w-72 shrink-0 flex-col gap-3 rounded-2xl border border-border/50 bg-muted/30 p-3"
        >
            <header className="flex shrink-0 items-center justify-between gap-2">
                <h3 className="flex min-w-0 items-center gap-2">
                    <CatalogChipDot color={status.color} density="comfortable" />
                    <span className="truncate text-sm font-semibold" title={status.label}>
                        {status.label}
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
                    {visibleCards.map((task) => (
                        <BoardCard
                            key={task.id}
                            task={task}
                            parentTitle={
                                task.parent_id === null
                                    ? null
                                    : (tasksById.get(task.parent_id)?.title ?? null)
                            }
                            memberNameById={memberNameById}
                        />
                    ))}

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
}

/** One task as a board card. */
function BoardCard({ task, parentTitle, memberNameById }: BoardCardProps) {
    const assignees: TaskAssigneeView[] = task.assignees.map((assignee) => ({
        user_id: assignee.user_id,
        full_name: assigneeName(assignee.user_id, memberNameById),
    }));
    const rangeText = formatTaskDateRange(task.start_date, task.end_date);

    return (
        <article
            data-slot="task-board-card"
            data-task-id={task.id}
            className="rounded-2xl border border-border/50 bg-card p-3 shadow-sm"
        >
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
        </article>
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

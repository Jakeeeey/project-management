"use client";

import { useMemo, type ReactNode } from "react";
import { LayoutGrid, RotateCcw, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CatalogChipDot } from "@/modules/project-management/components/CatalogChip";

import { assigneeName, type TaskViewProps } from "../../types/task-view";
import type { TaskCatalogOption, TaskListItem } from "../../hooks/useTasks";
import { AssigneeStack, type TaskAssigneeView } from "../AssigneeStack";
import { formatTaskDateRange } from "../TaskRow";
import { TaskPriorityBadge } from "../TaskRowBadges";

/**
 * Kanban board of the department's tasks.
 *
 * This is the read-only Board view of the tasks page: every column is one row of the department's
 * live status catalog (in catalog order), and every row in `items` is a card in the column its
 * `status_id` points at. The board never fetches and never writes — there is no drag-and-drop, no
 * reordering and no click target that mutates a task, because the List view stays the only editable
 * surface. Assignee initials are resolved through `memberNameById`, the same directory the list uses.
 *
 * @param props - the frozen `TaskViewProps` contract; the shell passes already-fetched data.
 */
export function BoardView({
    items,
    catalogs,
    memberNameById,
    isLoading,
    error,
    onRetry,
}: TaskViewProps) {
    /** The parent lookup for the card's "in <parent>" line — subtasks live in the same flat row set. */
    const tasksById = useMemo(() => {
        const byId = new Map<number, TaskListItem>();
        for (const task of items) byId.set(task.id, task);
        return byId;
    }, [items]);

    /** Cards bucketed by status once, so a wide department is not re-scanned per column. */
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
                message="No tasks in this department yet."
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

/** One status column: its catalog label, its card count, and its cards (or the empty line). */
function BoardColumn({ status, cards, tasksById, memberNameById }: BoardColumnProps) {
    const countLabel = `${cards.length} task${cards.length === 1 ? "" : "s"}`;

    return (
        <section
            data-slot="task-board-column"
            data-status-id={status.id}
            aria-label={status.label}
            className="flex w-72 shrink-0 flex-col gap-3 rounded-2xl border border-border/50 bg-muted/30 p-3"
        >
            <header className="flex items-center justify-between gap-2">
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
                <div className="flex flex-col gap-3">
                    {cards.map((task) => (
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

/**
 * One task as a board card.
 *
 * The row carries user ids only, so the assignee stack is built from the directory here — the same
 * `assigneeName` fallback the rest of the module uses, never a blank avatar name.
 */
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

            {parentTitle === null ? null : (
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

/** The board's full-width state card, matching the tree's loading / empty / error geometry. */
function BoardStatePanel({ icon, message, isAlert = false, onRetry }: BoardStatePanelProps) {
    return (
        <div
            data-slot="task-board-state-panel"
            className="flex h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
        >
            <div
                role={isAlert ? "alert" : undefined}
                // The tree's empty panel is the only one that tightens its gap; kept so the two
                // surfaces stay visually identical.
                className={cn("flex flex-col items-center justify-center gap-3", !isAlert && "gap-2")}
            >
                {icon}
                <p className="text-sm text-muted-foreground">{message}</p>
                {onRetry === undefined ? null : (
                    <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                        <RotateCcw className="size-4" aria-hidden="true" />
                        Try again
                    </Button>
                )}
            </div>
        </div>
    );
}

/** Fixed placeholder column/card counts — the catalogs are empty on a cold load, so they can't shape this. */
const SKELETON_COLUMNS: readonly string[] = ["one", "two", "three", "four"];
const SKELETON_CARDS: readonly string[] = ["one", "two", "three"];

/** The board's cold-load skeleton, shaped like the rendered columns and cards. */
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

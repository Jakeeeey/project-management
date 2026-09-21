"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
    ArrowRight,
    CalendarDays,
    ChevronLeft,
    ChevronRight,
    RotateCcw,
    TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatDateLong, toISODate } from "@/lib/utils";
import {
    CatalogChipDot,
    catalogSolidStyle,
    resolveCatalogHex,
} from "../CatalogChip";

import { assigneeName, type TaskViewProps } from "../../types/task-view";
import type { TaskListItem } from "../../hooks/useTasks";
import { parseDateOnly } from "../SingleDatePicker";
import { NO_STATUS_LABEL } from "../TaskRowBadges";

/**
 * Month calendar of the department's tasks.
 *
 * This is the read-only Calendar view of the tasks page. A task is placed on the day its
 * `start_date` names and nowhere else: the calendar answers "what begins on this day", not "what is
 * active on this day", because showing a task on every day of its range would demand a layout the
 * month grid cannot honestly express. A task whose `end_date` differs from its `start_date` earns an
 * arrow and its end date in the chip's tooltip, so the span is still legible.
 *
 * The grid is authored as local component state only — navigation never reaches the shell, because
 * the shell owns the fetcher and the List view owns the only editable surface. Every chip is a plain
 * `<span>`: nothing here is clickable, focusable or writable, so the view can never mutate a task.
 *
 * Dates are turned into `Date`s exclusively through `parseDateOnly` and rendered back through
 * `toISODate`, which keeps the day on the wall-clock the user picked; `new Date(value)` on a bare
 * `YYYY-MM-DD` string would read it as UTC midnight and slide a day in any zone behind UTC.
 *
 * @param props - the frozen `TaskViewProps` contract; the shell passes already-fetched data.
 */
export function CalendarView({
    items,
    memberNameById,
    isLoading,
    error,
    onRetry,
}: TaskViewProps) {
    const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(new Date()));

    /**
     * Today's local calendar day, resolved once. It drives the "today" cell treatment and is not a
     * live clock — a session left open past midnight keeps highlighting the day it started on,
     * which is acceptable for a presentational month grid.
     */
    const todayIso = useMemo(() => toISODate(new Date()), []);

    const calendar = useMemo(() => {
        const tasksByIso = new Map<string, TaskListItem[]>();
        let placed = 0;

        for (const task of items) {
            const date = parseDateOnly(task.start_date);
            if (date === undefined) continue;

            const iso = toISODate(date);
            placed += 1;
            const bucket = tasksByIso.get(iso);
            if (bucket === undefined) tasksByIso.set(iso, [task]);
            else bucket.push(task);
        }

        const year = viewMonth.getFullYear();
        const month = viewMonth.getMonth();
        const leadingDays = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        // Whole weeks only, so the weekday header never drifts out of alignment with the days.
        const cellsInMonth = leadingDays + daysInMonth;
        const weekCount = Math.ceil(cellsInMonth / 7);

        const cells: CalendarDay[] = [];
        for (let index = 0; index < weekCount * 7; index += 1) {
            const date = new Date(year, month, 1 - leadingDays + index);
            const iso = toISODate(date);
            cells.push({
                date,
                iso,
                inMonth: date.getMonth() === month,
                isToday: iso === todayIso,
                tasks: tasksByIso.get(iso) ?? [],
            });
        }

        return { cells, undated: items.length - placed };
    }, [items, viewMonth, todayIso]);

    const showError = error !== null && error !== "";
    const isEmpty = !isLoading && !showError && items.length === 0;

    const handlePreviousMonth = () => {
        setViewMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1));
    };

    const handleNextMonth = () => {
        setViewMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1));
    };

    const handleToday = () => {
        setViewMonth(startOfMonth(new Date()));
    };

    if (isLoading) return <CalendarSkeleton />;

    if (showError) {
        return (
            <CalendarStatePanel
                icon={<TriangleAlert className="size-8 text-destructive" aria-hidden="true" />}
                message={error}
                isAlert
                onRetry={onRetry}
            />
        );
    }

    if (isEmpty) {
        return (
            <CalendarStatePanel
                icon={<CalendarDays className="size-8 text-muted-foreground/50" aria-hidden="true" />}
                message="No tasks in this list yet."
            />
        );
    }

    return (
        <section data-slot="task-calendar" aria-label="Task calendar" className="w-full min-w-0 space-y-3">
            <div className="rounded-2xl border border-border/50 bg-card shadow-sm">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 p-3">
                    <h2 data-slot="task-calendar-month" className="text-sm font-semibold">
                        {formatDateLong(viewMonth)}
                    </h2>

                    <div className="flex items-center gap-1.5">
                        <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            aria-label="Previous month"
                            title="Previous month"
                            data-slot="task-calendar-previous"
                            onClick={handlePreviousMonth}
                        >
                            <ChevronLeft className="size-4" aria-hidden="true" />
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-slot="task-calendar-today"
                            onClick={handleToday}
                        >
                            Today
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            aria-label="Next month"
                            title="Next month"
                            data-slot="task-calendar-next"
                            onClick={handleNextMonth}
                        >
                            <ChevronRight className="size-4" aria-hidden="true" />
                        </Button>
                    </div>
                </header>

                {/* The grid keeps a legible floor width and scrolls INSIDE this box, so a 375px
                    viewport never gains a page-level horizontal scrollbar. */}
                <div data-slot="task-calendar-scroller" className="w-full min-w-0 overflow-x-auto p-3">
                    <div className="min-w-[600px] overflow-hidden rounded-xl border border-border/50">
                        <div className="grid grid-cols-7 border-b border-border/50 bg-muted/30">
                            {WEEKDAY_LABELS.map((label) => (
                                <div
                                    key={label}
                                    className="px-2 py-1.5 text-center text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
                                >
                                    {label}
                                </div>
                            ))}
                        </div>

                        <div className="grid grid-cols-7">
                            {calendar.cells.map((day) => (
                                <CalendarDayCell
                                    key={day.iso}
                                    day={day}
                                    memberNameById={memberNameById}
                                />
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <p
                data-slot="task-calendar-undated"
                className="px-1 text-xs text-muted-foreground"
                aria-live="polite"
            >
                {undatedLabel(calendar.undated)}
            </p>
        </section>
    );
}

/** Sunday-first, matching `Date.getDay()` — the same order the leading-day offset assumes. */
const WEEKDAY_LABELS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A day with more tasks than this shows a "+N more" line instead of growing without bound; a single
 * busy day must not push the whole month into an unreadable column of chips.
 */
const MAX_CHIPS_PER_DAY = 4;

interface CalendarDay {
    readonly date: Date;
    readonly iso: string;
    readonly inMonth: boolean;
    readonly isToday: boolean;
    readonly tasks: readonly TaskListItem[];
}

function startOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function isSpanning(task: TaskListItem): boolean {
    return task.start_date !== null && task.end_date !== null && task.end_date !== task.start_date;
}

/**
 * The chip's tooltip: the one place the full detail survives, since a chip is too small to carry it.
 *
 * It is built from the same helpers the rest of the module uses — never a second date format — and
 * falls back to the shared "no status" copy so a broken catalog reference still reads as intentional.
 */
function buildChipTitle(task: TaskListItem, memberNameById: ReadonlyMap<number, string>): string {
    const start = parseDateOnly(task.start_date);
    const end = parseDateOnly(task.end_date);

    const parts: string[] = [task.title];

    if (start !== undefined) {
        const spanText =
            isSpanning(task) && end !== undefined
                ? `${formatDateLong(start)} → ${formatDateLong(end)}`
                : `Starts ${formatDateLong(start)}`;
        parts.push(spanText);
    }

    parts.push(task.status?.label ?? NO_STATUS_LABEL);

    if (task.assignees.length > 0) {
        parts.push(
            task.assignees
                .map((assignee) => assigneeName(assignee.user_id, memberNameById))
                .join(", "),
        );
    }

    return parts.join(" · ");
}

/** The one-sentence report of what the calendar cannot show; always rendered so the count is never a surprise. */
function undatedLabel(undated: number): string {
    if (undated === 0) return "Every task has a start date and appears on the calendar.";
    if (undated === 1) return "1 task has no start date and is not on the calendar.";
    return `${undated} tasks have no start date and are not on the calendar.`;
}

interface CalendarDayCellProps {
    day: CalendarDay;
    memberNameById: ReadonlyMap<number, string>;
}

function CalendarDayCell({ day, memberNameById }: CalendarDayCellProps) {
    const visible = day.tasks.slice(0, MAX_CHIPS_PER_DAY);
    const hiddenCount = day.tasks.length - visible.length;
    const hiddenTitle = day.tasks
        .slice(MAX_CHIPS_PER_DAY)
        .map((task) => task.title)
        .join(" · ");

    return (
        <div
            data-slot="task-calendar-day"
            data-date={day.iso}
            data-outside-month={day.inMonth ? undefined : "true"}
            title={formatDateLong(day.date)}
            className={cn(
                "flex min-h-[112px] min-w-0 flex-col gap-1 border-r border-b border-border/50 p-1.5",
                !day.inMonth && "bg-muted/20",
                day.isToday && "bg-primary/5",
                "[&:nth-child(7n)]:border-r-0",
                "[&:nth-last-child(-n+7)]:border-b-0",
            )}
        >
            <div className="flex items-center gap-1">
                <span
                    className={cn(
                        "grid size-5 shrink-0 place-items-center rounded-full text-[11px] tabular-nums",
                        day.isToday && "bg-primary font-semibold text-primary-foreground",
                        !day.isToday && day.inMonth && "font-medium",
                        !day.isToday && !day.inMonth && "text-muted-foreground/60",
                    )}
                >
                    {day.date.getDate()}
                </span>
                {day.isToday ? (
                    <span className="text-[10px] font-semibold tracking-wide text-primary uppercase">
                        Today
                    </span>
                ) : null}
            </div>

            <div className="flex min-w-0 flex-col gap-0.5">
                {visible.map((task) => (
                    <CalendarTaskChip key={task.id} task={task} memberNameById={memberNameById} />
                ))}

                {hiddenCount > 0 ? (
                    <p
                        data-slot="task-calendar-more"
                        className="truncate px-1 text-[10px] text-muted-foreground"
                        title={hiddenTitle}
                    >
                        +{hiddenCount} more
                    </p>
                ) : null}
            </div>
        </div>
    );
}

interface CalendarTaskChipProps {
    task: TaskListItem;
    memberNameById: ReadonlyMap<number, string>;
}

/**
 * One task as a compact chip.
 *
 * A `<span>`, deliberately: the calendar is read-only, so a chip must not be focusable, must not be
 * a button and must not open anything. A stored status colour fills it SOLIDLY through the shared
 * `catalogSolidStyle` (never a Tailwind class, which cannot hold a user-chosen colour) with a
 * luminance-derived label, so it matches the catalog chips elsewhere. A task whose status has no
 * colour keeps the neutral border and the muted dot instead.
 */
function CalendarTaskChip({ task, memberNameById }: CalendarTaskChipProps) {
    const spanning = isSpanning(task);
    const end = parseDateOnly(task.end_date);
    const hex = resolveCatalogHex(task.status?.color);

    return (
        <span
            data-slot="task-calendar-chip"
            data-task-id={task.id}
            data-spanning={spanning ? "true" : undefined}
            title={buildChipTitle(task, memberNameById)}
            style={hex === null ? undefined : catalogSolidStyle(hex)}
            className={cn(
                "flex min-w-0 items-center gap-1 rounded-md border px-1 py-0.5 text-[11px] font-semibold uppercase leading-tight tracking-wide",
                hex === null &&
                    (spanning
                        ? "border-border/70 bg-muted/40 text-foreground"
                        : "border-border/60 bg-background/80 text-foreground"),
            )}
        >
            {hex === null ? <CatalogChipDot density="dense" /> : null}
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            {spanning ? (
                <>
                    <ArrowRight className="size-3 shrink-0 opacity-70" aria-hidden="true" />
                    {end === undefined ? null : (
                        <span className="sr-only">{`ends ${formatDateLong(end)}`}</span>
                    )}
                </>
            ) : null}
        </span>
    );
}

interface CalendarStatePanelProps {
    icon: ReactNode;
    message: string;
    /** Error panels announce themselves; loading and empty panels are passive. */
    isAlert?: boolean;
    onRetry?: () => void;
}

/** The calendar's full-width state card, matching the tree's loading / empty / error geometry. */
function CalendarStatePanel({ icon, message, isAlert = false, onRetry }: CalendarStatePanelProps) {
    return (
        <div
            data-slot="task-calendar-state-panel"
            className="flex h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
        >
            <div
                role={isAlert ? "alert" : undefined}
                className="flex flex-col items-center justify-center gap-3"
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

/** A fixed 5×7 block of placeholder cells — the cold load has no month to shape from. */
const SKELETON_DAY_COUNT = 35;

function CalendarSkeleton() {
    return (
        <div
            data-slot="task-calendar-loading"
            role="status"
            aria-label="Loading tasks"
            className="w-full min-w-0"
        >
            <div className="rounded-2xl border border-border/50 bg-card shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 p-3">
                    <Skeleton className="h-5 w-40" />
                    <div className="flex items-center gap-1.5">
                        <Skeleton className="size-8 rounded-md" />
                        <Skeleton className="h-8 w-16 rounded-md" />
                        <Skeleton className="size-8 rounded-md" />
                    </div>
                </div>
                <div className="overflow-hidden p-3">
                    <div className="overflow-hidden rounded-xl border border-border/50">
                        <div className="grid grid-cols-7 border-b border-border/50 bg-muted/30">
                            {WEEKDAY_LABELS.map((label) => (
                                <Skeleton key={label} className="m-1.5 h-3 rounded-md" />
                            ))}
                        </div>
                        <div className="grid grid-cols-7 gap-px bg-border/40">
                            {Array.from({ length: SKELETON_DAY_COUNT }, (_, index) => (
                                <Skeleton key={index} className="h-24 rounded-none" />
                            ))}
                        </div>
                    </div>
                </div>
            </div>
            <span className="sr-only">Loading tasks…</span>
        </div>
    );
}

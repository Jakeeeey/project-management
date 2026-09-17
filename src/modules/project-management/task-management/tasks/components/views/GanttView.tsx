"use client";

import { Component, useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { ChartGantt, RotateCcw, TriangleAlert } from "lucide-react";
import type { ITask } from "@svar-ui/react-gantt";

import "@svar-ui/react-gantt/style.css";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { parseDateOnly } from "../SingleDatePicker";
import type { TaskViewProps } from "../../types/task-view";

/**
 * The SVAR Gantt chart, loaded lazily **on the client only**.
 *
 * `@svar-ui/react-gantt` ships an ES bundle with no `'use client'` banner and no SSR guard, so a
 * static import would be evaluated — and its render attempted — during the server pass that every
 * "use client" component still gets in the Next 16 App Router. `next/dynamic` with `ssr: false` is
 * the chosen mount gate: it keeps the library out of the server bundle entirely (neither the module
 * body nor the render runs on the server) and hands us a chunk-loading fallback for free. The
 * alternative — a `useEffect`-set `mounted` flag — would still import and evaluate the module on the
 * server, which is the half of the hazard this approach removes.
 */
const GanttChart = dynamic(
    () => import("@svar-ui/react-gantt").then((module) => module.Gantt),
    {
        ssr: false,
        loading: () => (
            <GanttStatePanel
                icon={<Spinner className="size-6 text-muted-foreground" />}
                message="Loading timeline…"
                pulse
            />
        ),
    },
);

/**
 * The library's theme contract, scoped to `.pm-task-gantt`.
 *
 * The library reads its colours/sizes from `--wx-*` custom properties. Its own defaults live under
 * `.wx-material-theme` / `.wx-willow-theme`, which this app never mounts, so every property the
 * chart actually reads is declared here and remapped onto the app's slate/shadcn tokens
 * (`--background`, `--foreground`, `--border`, `--muted`, `--card`, `--primary`, `--destructive`,
 * `--success`, `--accent`). Because these are plain custom properties set on ONE class, they only
 * cascade into this wrapper's subtree — they cannot leak into the rest of the app.
 *
 * Only variables the library reads are declared; `--wx-table-*` is deliberately omitted because the
 * library sets those on its own `.wx-table` element and remaps them from these values.
 */
const GANTT_THEME_CSS = `
.pm-task-gantt {
    --wx-font-family: var(--font-sans, ui-sans-serif), system-ui, sans-serif;
    --wx-font-size: 0.875rem;
    --wx-font-size-sm: 0.75rem;
    --wx-font-weight: 400;
    --wx-font-weight-md: 500;
    --wx-header-font-weight: 600;
    --wx-icon-color: hsl(var(--muted-foreground));
    --wx-icon-size: 1rem;
    --wx-color-primary: hsl(var(--primary));
    --wx-color-link: hsl(var(--primary));
    --wx-color-font: hsl(var(--foreground));
    --wx-color-font-disabled: hsl(var(--muted-foreground));
    --wx-color-secondary-font: hsl(var(--muted-foreground));
    --wx-color-danger: hsl(var(--destructive));
    --wx-background: hsl(var(--card));
    --wx-background-alt: hsl(var(--muted));
    --wx-border: 1px solid hsl(var(--border));
    --wx-body-offset: 0px;
    --wx-scrollbar-width: 6px;

    --wx-gantt-border-color: hsl(var(--border));
    --wx-gantt-border: 1px solid hsl(var(--border));
    --wx-gantt-form-header-border: 1px solid hsl(var(--border));
    --wx-gantt-icon-color: hsl(var(--muted-foreground));
    --wx-gantt-bar-font: var(--wx-font-weight-md) var(--wx-font-size) var(--wx-font-family);
    --wx-gantt-bar-border-radius: 0.375rem;
    --wx-gantt-bar-shadow: 0 1px 2px hsl(var(--foreground) / 0.06), 0 3px 10px hsl(var(--foreground) / 0.12);
    --wx-gantt-baseline-border-radius: 0.25rem;
    --wx-gantt-critical-color: hsl(var(--destructive));
    --wx-gantt-task-color: hsl(var(--primary));
    --wx-gantt-task-font-color: hsl(var(--primary-foreground));
    --wx-gantt-task-fill-color: hsl(var(--primary));
    --wx-gantt-task-border-color: hsl(var(--primary));
    --wx-gantt-task-border: 1px solid hsl(var(--primary));
    --wx-gantt-task-critical-color: hsl(var(--destructive));
    --wx-gantt-task-critical-fill-color: hsl(var(--destructive));
    --wx-gantt-task-slack-color: hsl(var(--muted));
    --wx-gantt-task-slack-border-color: hsl(var(--border));
    --wx-gantt-summary-color: hsl(var(--primary));
    --wx-gantt-summary-font-color: hsl(var(--foreground));
    --wx-gantt-summary-fill-color: hsl(var(--primary));
    --wx-gantt-summary-border-color: hsl(var(--primary));
    --wx-gantt-summary-border: 1px solid hsl(var(--primary));
    --wx-gantt-summary-critical-color: hsl(var(--destructive));
    --wx-gantt-summary-critical-fill-color: hsl(var(--destructive));
    --wx-gantt-milestone-color: hsl(var(--primary));
    --wx-gantt-milestone-border-radius: 0.25rem;
    --wx-gantt-select-color: hsl(var(--accent));
    --wx-gantt-link-color: hsl(var(--muted-foreground));
    --wx-gantt-link-color-hovered: hsl(var(--foreground));
    --wx-gantt-link-critical-color: hsl(var(--destructive));
    --wx-gantt-link-critical-color-hovered: hsl(var(--destructive));
    --wx-gantt-link-marker-background: hsl(var(--card));
    --wx-gantt-link-marker-color: hsl(var(--muted-foreground));
    --wx-gantt-progress-marker-height: 22px;
    --wx-gantt-progress-border-color: hsl(var(--border));
    --wx-gantt-holiday-background: hsl(var(--muted));
    --wx-gantt-holiday-color: hsl(var(--muted-foreground));
    --wx-gantt-marker-font: var(--wx-font-weight-md) var(--wx-font-size-sm) var(--wx-font-family);
    --wx-gantt-marker-font-color: hsl(var(--primary-foreground));
    --wx-gantt-marker-color: hsl(var(--primary) / 0.8);
    --wx-gantt-load-normal-color: hsl(var(--success) / 0.12);
    --wx-gantt-load-danger-color: hsl(var(--destructive) / 0.12);

    --wx-grid-header-font: var(--wx-font-weight-md) var(--wx-font-size-sm) var(--wx-font-family);
    --wx-grid-header-font-color: hsl(var(--muted-foreground));
    --wx-grid-header-text-transform: uppercase;
    --wx-grid-header-shadow: none;
    --wx-grid-header-sort-padding-right: 4px;
    --wx-grid-body-font: var(--wx-font-weight) var(--wx-font-size) var(--wx-font-family);
    --wx-grid-body-font-color: hsl(var(--foreground));
    --wx-grid-body-row-border: 1px solid hsl(var(--border));
    --wx-grid-body-cell-border: 1px solid transparent;
    --wx-grid-cell-padding-x: 0.75rem;
    --wx-grid-tree-column-padding-left: 3px;
    --wx-timescale-font: var(--wx-font-weight-md) var(--wx-font-size-sm) var(--wx-font-family);
    --wx-timescale-font-color: hsl(var(--muted-foreground));
    --wx-timescale-shadow: none;
    --wx-timescale-border: 1px solid hsl(var(--border));
    --wx-sidebar-close-icon: hsl(var(--muted-foreground));
}
`;

interface GanttErrorBoundaryProps {
    children: ReactNode;
    fallback: ReactNode;
}

interface GanttErrorBoundaryState {
    hasError: boolean;
}

/**
 * Keeps a third-party render crash inside this view.
 *
 * The Gantt library owns its own rendering, so a regression in it (or an unexpected task shape)
 * would otherwise suspend the whole tasks page with a blank screen. A class boundary is still the
 * only React primitive that catches render errors, so the view degrades to a message instead.
 */
class GanttErrorBoundary extends Component<GanttErrorBoundaryProps, GanttErrorBoundaryState> {
    state: GanttErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(): GanttErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: unknown): void {
        console.error("GanttView: the timeline failed to render.", error);
    }

    render(): ReactNode {
        return this.state.hasError ? this.props.fallback : this.props.children;
    }
}

interface GanttStatePanelProps {
    icon: ReactNode;
    message: string;
    /** Error panels announce themselves; loading and empty panels are passive. */
    isAlert?: boolean;
    pulse?: boolean;
    onRetry?: () => void;
}

/** The full-width state card, matching the task tree's loading / empty / error geometry exactly. */
function GanttStatePanel({
    icon,
    message,
    isAlert = false,
    pulse = false,
    onRetry,
}: GanttStatePanelProps) {
    return (
        <div
            data-slot="task-gantt-state-panel"
            className="flex h-48 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
        >
            <div
                role={isAlert ? "alert" : undefined}
                className="flex flex-col items-center justify-center gap-3"
            >
                {icon}
                <p className={cn("text-sm text-muted-foreground", pulse && "animate-pulse")}>{message}</p>
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

/** One row per task that cannot be placed, with the reason it was dropped. */
function skippedLabel(withoutDates: number, invertedRange: number): string {
    const parts: string[] = [];

    if (withoutDates > 0) {
        parts.push(
            withoutDates === 1
                ? "1 task is missing a start date or a due date"
                : `${withoutDates} tasks are missing a start date or a due date`,
        );
    }

    if (invertedRange > 0) {
        parts.push(
            invertedRange === 1
                ? "1 task has a due date before its start date"
                : `${invertedRange} tasks have a due date before their start date`,
        );
    }

    if (parts.length === 0) {
        return "Every task has both dates and appears on the timeline.";
    }

    return `${parts.join(", and ")} — not shown on the timeline.`;
}

/**
 * The tasks page's read-only Gantt timeline.
 *
 * Every task that carries BOTH a `start_date` and an `end_date` becomes one bar; a task missing
 * either date, or whose due date precedes its start date, cannot be placed on a time axis and is
 * reported in the muted line under the chart instead of being drawn at a guessed position. When no
 * task can be placed at all, the view renders an empty state rather than an empty timeline.
 *
 * This view is READ-ONLY by construction, matching the view contract's intent: the library is given
 * its own `readonly` flag, which strips the editor column, drops the add-task column and disables
 * drag/resize, and **no** `on*` mutation callback is passed. Nothing here writes, and no part of the
 * row data is mutated — the projection is rebuilt with `useMemo` from `items`.
 *
 * Dates enter as `YYYY-MM-DD` strings and are converted only through `parseDateOnly` (local calendar
 * parts). `new Date("YYYY-MM-DD")` reads the string as UTC midnight, which would slide every bar one
 * day back in any zone behind UTC.
 *
 * The library is mounted through `next/dynamic` with `ssr: false`, so neither its module body nor its
 * render ever runs on the server; the wrapper's `--wx-*` overrides are scoped to `.pm-task-gantt`,
 * and a render error in the library is caught by a boundary so it degrades to a panel rather than
 * blanking the tasks page.
 *
 * @param props - the frozen `TaskViewProps` contract; the shell passes already-fetched data and the
 *                retry callback, and this view never fetches.
 */
export function GanttView({ items, isLoading, error, onRetry }: TaskViewProps) {
    /**
     * The library's task list, derived in one pass from the department's flat rows. Kept as `ITask[]`
     * exactly as the component's `tasks` prop expects, and rebuilt only when `items` changes.
     */
    const projection = useMemo(() => {
        const tasks: ITask[] = [];
        let withoutDates = 0;
        let invertedRange = 0;

        for (const item of items) {
            const start = parseDateOnly(item.start_date);
            const end = parseDateOnly(item.end_date);

            if (start === undefined || end === undefined) {
                withoutDates += 1;
                continue;
            }

            // A due date before the start date is not a real span; the time axis has no width to draw.
            if (end.getTime() < start.getTime()) {
                invertedRange += 1;
                continue;
            }

            tasks.push({
                id: item.id,
                // A blank stored title would leave an unlabelled bar; the id keeps it addressable.
                text: item.title.trim() === "" ? `Task #${item.id}` : item.title,
                start,
                end,
                type: "task",
            });
        }

        return { tasks, withoutDates, invertedRange };
    }, [items]);

    const showError = error !== null && error !== "";
    const isEmpty = !isLoading && !showError && projection.tasks.length === 0;
    const skipMessage = skippedLabel(projection.withoutDates, projection.invertedRange);

    if (isLoading) {
        return (
            <GanttStatePanel
                icon={<Spinner className="size-6 text-muted-foreground" />}
                message="Loading tasks…"
                pulse
            />
        );
    }

    if (showError) {
        return (
            <GanttStatePanel
                icon={<TriangleAlert className="size-8 text-destructive" aria-hidden="true" />}
                message={error}
                isAlert
                onRetry={onRetry}
            />
        );
    }

    if (isEmpty) {
        return (
            <section data-slot="task-gantt" aria-label="Task timeline" className="w-full min-w-0 space-y-3">
                <GanttStatePanel
                    icon={<ChartGantt className="size-8 text-muted-foreground/50" aria-hidden="true" />}
                    message={
                        items.length === 0
                            ? "No tasks in this department yet."
                            : "No task has both a start date and a due date, so there is nothing to place on the timeline."
                    }
                />
                <p
                    data-slot="task-gantt-skipped"
                    className="px-1 text-xs text-muted-foreground"
                    aria-live="polite"
                >
                    {skipMessage}
                </p>
            </section>
        );
    }

    return (
        <section data-slot="task-gantt" aria-label="Task timeline" className="w-full min-w-0 space-y-3">
            <style>{GANTT_THEME_CSS}</style>

            {/* `overflow-hidden` + a bounded height keep the chart's own scrolling inside this box, so a
                375px viewport never gains a page-level horizontal scrollbar. */}
            <div
                data-slot="task-gantt-chart"
                className="pm-task-gantt h-[70vh] max-h-[720px] min-h-[360px] w-full overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm"
            >
                <GanttErrorBoundary
                    fallback={
                        <GanttStatePanel
                            icon={<TriangleAlert className="size-8 text-destructive" aria-hidden="true" />}
                            message="The timeline could not be displayed."
                            isAlert
                        />
                    }
                >
                    {/* `readonly` removes the add-task column and every editor; no `on*` write
                        callback is passed, so there is no path from this view back to a mutation. */}
                    <GanttChart tasks={projection.tasks} readonly />
                </GanttErrorBoundary>
            </div>

            <p
                data-slot="task-gantt-skipped"
                className="px-1 text-xs text-muted-foreground"
                aria-live="polite"
            >
                {skipMessage}
            </p>
        </section>
    );
}

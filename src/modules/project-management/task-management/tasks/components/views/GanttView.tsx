"use client";

import { Component, useCallback, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import dynamic from "next/dynamic";
import {
    CalendarDays,
    ChartGantt,
    ChevronLeft,
    ChevronRight,
    RotateCcw,
    TriangleAlert,
} from "lucide-react";
import type { IApi, ITask } from "@svar-ui/react-gantt";

import "@svar-ui/react-gantt/style.css";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import {
    resolveCatalogForeground,
    resolveCatalogHex,
} from "@/modules/project-management/components/CatalogChip";

import { parseDateOnly } from "../SingleDatePicker";
import { GANTT_TODAY_CLASS, highlightToday } from "./gantt-today";
import type { TaskViewProps } from "../../types/task-view";
import type { TaskListItem } from "../../hooks/useTasks";

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
 *
 * The loader also binds the chart's own `columns`, for a reason that is NOT cosmetic — see below.
 *
 * ## The collapsed-sidebar "unique key" warning, and this workaround
 *
 * Collapsing the label sidepanel sets the store's `displayMode` to `"chart"`. To fill the narrow
 * strip that remains, react-gantt builds the sidebar's column list as:
 *
 *     e === "chart"
 *         ? [{ ...t.filter((n) => n.id === "add-task")[0], resize: false }]
 *         : t
 *
 * (`Dt` in `@svar-ui/react-gantt@2.7.3`.) In `readonly` the vendor first **removes** the add-task
 * column — `if (d !== -1) { … if (e) f.splice(d, 1) }` — so the `find` returns `undefined` and the
 * spread becomes `{ ...undefined, resize: false }`: a column with **no `id`**. React Grid then keys
 * every header/footer cell by `cell.id` (`key={b.id}` in its `Lt` render), so `key={undefined}`
 * makes React warn "Each child in a list should have a unique key prop. Check the render method of
 * Lt." It is a vendor bug we cannot patch (no `node_modules` edits) and must not suppress.
 *
 * The fix from the host: pass the vendor's own `defaultColumns` back to it — all four already carry
 * ids (`text`, `start`, `duration`, `add-task`) — and append a **second, hidden `add-task` entry**.
 * `readonly` consumes exactly one add-task (its `splice`), so the duplicate survives the lookup and
 * the collapsed column is built from a real column with `id: "add-task"` instead of `undefined`.
 * `hidden` keeps the duplicate out of the expanded sidebar, so the default `all` view is unchanged.
 * Nothing under `node_modules` is touched and the warning is not suppressed — the offending column
 * is prevented rather than silenced.
 */
const GanttChart = dynamic(
    () =>
        import("@svar-ui/react-gantt").then((module) => {
            const Gantt = module.Gantt;
            const columns = [
                ...module.defaultColumns.map((column, index) => ({
                    ...column,
                    id: column.id ?? `column-${index}`,
                })),
                { id: "add-task", header: "", width: 0, hidden: true, sort: false, resize: false },
            ];
            return function ColumnBoundGantt(props: ComponentProps<typeof Gantt>) {
                return <Gantt {...props} columns={columns} />;
            };
        }),
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
 * The vendor icon font, fetched at runtime.
 *
 * The library renders its controls as `<i class="… wxi-…">` and relies on a *separate* stylesheet for
 * the glyphs. Measured facts about the installed package (`@svar-ui/react-gantt@2.7.3`):
 *
 * - `dist/index.css` (what `style.css` maps to) has ZERO `@font-face` rules and ZERO `wxi-` rules.
 * - `dist-full/index.css` (what `all.css` maps to) is NOT the fix either: its 6 `@font-face` rules are
 *   only Roboto / Open Sans, it defines no `wxi-` glyph `content`, and its theme blocks
 *   (`.wx-material-theme`, `.wx-willow-theme`) do not supply the font. Swapping to `all.css` would
 *   therefore NOT render a single icon.
 * - The glyphs live in `https://cdn.svar.dev/fonts/wxi/wx-icons.css` (96 `:before` `content` rules +
 *   a `wx-icons` `@font-face`). The library injects that stylesheet itself, but only from its
 *   `<Material>` / `<Willow>` wrappers — components this view deliberately does NOT mount, because
 *   they add the vendor's own `.wx-*-theme` class and would override the app's remap (see below).
 *
 * So the fix is to load exactly that one stylesheet, without the theme wrapper. It contains no
 * `--wx-*` custom properties and no `.wx-*-theme` selectors (verified by counting), so it cannot
 * regress the theme. It is declared with `@import` at the top of the stylesheet because `@import`
 * must precede every other rule.
 */
const GANTT_ICON_FONT_CSS = `@import url("https://cdn.svar.dev/fonts/wxi/wx-icons.css");`;

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
const GANTT_THEME_CSS = `${GANTT_ICON_FONT_CSS}
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

/**
 * The current-day marker, applied by the `highlightTime` callback to today's day columns.
 *
 * `highlightTime` returns a CLASS NAME, not a style, so the name is inert unless a rule for it
 * actually reaches the chart. It is declared here — and prefixed with `.pm-task-gantt` — for the
 * same reason the theme block is: the `<style>` tag is global, so the wrapper scope keeps the rule
 * inside this view's subtree and prevents a leak or a collision anywhere else.
 *
 * The vendor emits the class in TWO places, both fed from the same callback:
 *
 * 1. On the `.wx-cell` of the sticky day scale (the day number row). No vendor rule paints a plain
 *    `.wx-cell` background, so the tint below is the one that shows — this is the marker in the
 *    header strip.
 * 2. On a full-height column div inside the vendor's `.wx-gantt-holidays` overlay. That overlay is
 *    where a shaded weekend column is normally drawn, and it is rendered *before* the bars, so the
 *    tint sits behind them. The catch: the vendor's own `wx-weekend` class carries the geometry
 *    (`position:absolute; height:100%`); a bare custom class carries none, so its column div
 *    collapses to zero height. The second rule supplies that geometry, which is what turns today's
 *    column into a real full-height tint rather than a header-only cell.
 *
 * The tint uses `--primary` to stay inside the app's palette and off the bar status colours (which
 * live on the bars, not the scale). `--foreground` on the tint stays legible in the dark theme.
 */
const GANTT_TODAY_CSS = `.pm-task-gantt .${GANTT_TODAY_CLASS} {
    background-color: hsl(var(--primary) / 0.32);
    color: hsl(var(--foreground));
    box-shadow: inset 0 2px 0 hsl(var(--primary)), inset 0 -2px 0 hsl(var(--primary));
    font-weight: 600;
}
.pm-task-gantt .wx-gantt-holidays > .${GANTT_TODAY_CLASS} {
    position: absolute;
    top: 0;
    bottom: 0;
    height: 100%;
    background-color: hsl(var(--primary) / 0.4);
    box-shadow: inset 1px 0 0 hsl(var(--primary)), inset -1px 0 0 hsl(var(--primary));
    pointer-events: none;
}`;

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

/** Months of empty timeline left reachable before the first and after the last task. */
const NAVIGABLE_PADDING_MONTHS = 6;

/**
 * Pixels per day. The vendor default is `cellWidth = 100`, which shows only three or four days at a
 * time; a month is the unit this view navigates by, so a more compact cell keeps a usable slice of
 * that month on screen.
 */
const GANTT_CELL_WIDTH = 36;

/** Month granularity helpers. Every one works in LOCAL calendar parts, never UTC. */
function monthStart(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthEnd(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function shiftMonths(date: Date, count: number): Date {
    return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

/**
 * `September 2026`, from a FIXED locale.
 *
 * The locale is pinned rather than left to the runtime so a server pass and a client pass can never
 * disagree about the string, and so the label is stable regardless of the viewer's machine settings.
 */
const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

function monthLabel(date: Date): string {
    return MONTH_LABEL_FORMAT.format(date);
}

/** The scrollable span the chart is given, plus the months the navigation may actually land on. */
interface GanttRange {
    readonly start: Date;
    readonly end: Date;
    readonly minAnchor: Date;
    readonly maxAnchor: Date;
}

/**
 * Builds the timeline's range once per row set.
 *
 * The range deliberately does NOT depend on the navigation anchor. It is derived only from the tasks
 * (padded on both sides and widened to include today), so stepping a month changes nothing but the
 * scroll position — the store is never re-initialised mid-navigation, and there is no window where a
 * re-init races the scroll. The returned anchors are the months a user may land on.
 */
function buildRange(items: readonly TaskListItem[]): GanttRange {
    const today = new Date();
    let minTime = today.getTime();
    let maxTime = today.getTime();

    for (const item of items) {
        const start = parseDateOnly(item.start_date);
        const end = parseDateOnly(item.end_date);

        if (start !== undefined) {
            minTime = Math.min(minTime, start.getTime());
            maxTime = Math.max(maxTime, start.getTime());
        }
        if (end !== undefined) {
            minTime = Math.min(minTime, end.getTime());
            maxTime = Math.max(maxTime, end.getTime());
        }
    }

    const minAnchor = shiftMonths(monthStart(new Date(minTime)), -NAVIGABLE_PADDING_MONTHS);
    const maxAnchor = shiftMonths(monthStart(new Date(maxTime)), NAVIGABLE_PADDING_MONTHS);

    return { start: minAnchor, end: monthEnd(maxAnchor), minAnchor, maxAnchor };
}

/**
 * One CSS rule per task that carries a status colour, keyed to the vendor's own bar variables.
 *
 * The vendor exposes no per-task colour property (both its bundles contain zero occurrences of
 * `color`; `ITask`'s index signature accepts an extra key but ignores it). What it does expose is the
 * cascade: a task bar is an element carrying `data-task-id` that paints itself with
 * `background-color: var(--wx-gantt-task-color)`. Declaring that variable ON the `[data-task-id]`
 * node therefore beats the single declaration on `.pm-task-gantt`, because a custom property set on
 * the element itself resolves before any inherited value.
 *
 * The colour is keyed to the task's **status** (`pm_task_status.color`, the same stored hex the rest
 * of the module paints through `CatalogChip`), so a bar's colour means the same thing here as it does
 * in the tree. `resolveCatalogForeground` picks near-black or white for the bar's label so text stays
 * legible on every status colour. Tasks without a valid status hex keep the theme's default primary.
 *
 * Fidelity note: this targets the STABLE `data-task-id` attribute, not the vendor's CSS-module class
 * hash (`.wx-GKbcLEGA`), which changes between releases.
 */
function buildBarColourCss(items: readonly TaskListItem[]): string {
    const rules: string[] = [];

    for (const item of items) {
        const hex = resolveCatalogHex(item.status?.color);
        if (hex === null) {
            continue;
        }

        const foreground = resolveCatalogForeground(hex);
        rules.push(
            `.pm-task-gantt [data-task-id="${item.id}"]{` +
                `--wx-gantt-task-color:${hex};` +
                `--wx-gantt-task-fill-color:${hex};` +
                `--wx-gantt-task-border:1px solid ${hex};` +
                `--wx-gantt-task-font-color:${foreground};` +
                `}`,
        );
    }

    return rules.join("");
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

    const range = useMemo(() => buildRange(items), [items]);
    const barColourRules = useMemo(() => buildBarColourCss(items), [items]);

    /** The month the user navigated to, or `null` while the view still follows the data. */
    const [anchor, setAnchor] = useState<Date | null>(null);

    /** The store handle from `init` — the only route to the library's actions. */
    const [api, setApi] = useState<IApi | null>(null);

    const handleReady = useCallback((next: IApi) => {
        setApi(next);
    }, []);

    const defaultAnchor = useMemo(() => {
        const today = monthStart(new Date());
        if (today.getTime() < range.minAnchor.getTime()) {
            return range.minAnchor;
        }
        if (today.getTime() > range.maxAnchor.getTime()) {
            return range.maxAnchor;
        }
        return today;
    }, [range]);

    const visibleMonth = anchor ?? defaultAnchor;

    const goToMonth = useCallback(
        (next: Date) => {
            const clamped = Math.min(
                Math.max(next.getTime(), range.minAnchor.getTime()),
                range.maxAnchor.getTime(),
            );
            setAnchor(monthStart(new Date(clamped)));
        },
        [range],
    );

    const showPreviousMonth = useCallback(() => {
        goToMonth(shiftMonths(visibleMonth, -1));
    }, [goToMonth, visibleMonth]);

    const showNextMonth = useCallback(() => {
        goToMonth(shiftMonths(visibleMonth, 1));
    }, [goToMonth, visibleMonth]);

    const showToday = useCallback(() => {
        goToMonth(monthStart(new Date()));
    }, [goToMonth]);

    /**
     * Scrolls the chart onto the current month.
     *
     * `scroll-chart` is the store's own action for this; it converts `{ date }` into a pixel offset
     * from the chart's start and moves the chart there. It must re-run whenever the range changes,
     * because the library re-initialises its store from `start`/`end` and that resets the scroll.
     */
    useEffect(() => {
        if (api === null) {
            return;
        }

        void api.exec("scroll-chart", { date: monthStart(visibleMonth) });
    }, [api, visibleMonth, range]);

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
            <style>{GANTT_THEME_CSS + GANTT_TODAY_CSS + barColourRules}</style>

            {/* The library exposes the store action but renders no toolbar of its own, so the month
                stepper is hosted here. Its buttons use the app's own Lucide icons and are therefore
                never blank, independent of the vendor font. */}
            <div
                data-slot="task-gantt-nav"
                role="group"
                aria-label="Timeline navigation"
                className="flex flex-wrap items-center justify-center gap-2"
            >
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Show the previous month"
                    onClick={showPreviousMonth}
                >
                    <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>

                <p
                    data-slot="task-gantt-period"
                    aria-live="polite"
                    className="min-w-36 text-center text-sm font-medium tabular-nums text-muted-foreground"
                >
                    {monthLabel(visibleMonth)}
                </p>

                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Show the next month"
                    onClick={showNextMonth}
                >
                    <ChevronRight className="size-4" aria-hidden="true" />
                </Button>

                <Button type="button" variant="outline" size="sm" onClick={showToday}>
                    <CalendarDays className="size-4" aria-hidden="true" />
                    Today
                </Button>
            </div>

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
                        callback is passed, so there is no path from this view back to a mutation.

                        `autoScale` is switched off so the visible span is the one computed from the
                        rows (plus padding), not one fitted to the tasks — without that, the range
                        cannot extend past the last task and month stepping has nowhere to go. */}
                    <GanttChart
                        tasks={projection.tasks}
                        readonly
                        autoScale={false}
                        start={range.start}
                        end={range.end}
                        cellWidth={GANTT_CELL_WIDTH}
                        highlightTime={highlightToday}
                        init={handleReady}
                    />
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

"use client";

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import dynamic from "next/dynamic";
import {
    CalendarDays,
    ChartGantt,
    ChevronLeft,
    ChevronRight,
    FoldVertical,
    Maximize2,
    RotateCcw,
    TriangleAlert,
    UnfoldVertical,
    X,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import type { IApi, ILink, IResource, ITask } from "@svar-ui/react-gantt";

import "@svar-ui/react-gantt/style.css";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn, formatDateLong } from "@/lib/utils";

import { assigneeColorFor, assigneeForegroundFor } from "../assignee-color";
import { CatalogStatusIcon } from "../CatalogStatusIcon";
import { NO_STATUS_LABEL } from "../TaskRowBadges";

import { parseDateOnly } from "../SingleDatePicker";
import { GANTT_TODAY_CLASS, highlightToday } from "./gantt-today";
import { assigneeName, type TaskViewProps } from "../../types/task-view";
import type { TaskCatalogRef, TaskListItem } from "../../hooks/useTasks";

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
                ...module.defaultColumns.map((column, index) => {
                    const id = column.id ?? `column-${index}`;
                    // The `text` column carries the host label cell; the vendor folds it into its own
                    // tree-row renderer — see `GanttTaskLabelCell`.
                    return id === "text" ? { ...column, id, cell: GanttTaskLabelCell } : { ...column, id };
                }),
                { id: "add-task", header: "", width: 0, hidden: true, sort: false, resize: false },
            ];
            return function ColumnBoundGantt(props: ComponentProps<typeof Gantt>) {
                // The inline chart never passes `columns` and keeps the bound label column; the
                // fullscreen modal passes `columns={[]}` so its chart renders with no sidebar —
                // bar labels plus the tooltip replace the label column there (see `GanttBarLabel`).
                // `[]`, not the documented `false`: the prop types intersect the two column types,
                // so `false` is a compile error, while an empty array flows through the same
                // length-guarded no-sidebar path in the store and the layout.
                return <Gantt {...props} columns={props.columns ?? columns} />;
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
 * The vendor's hover tooltip, loaded lazily on the client only, for the same SSR reason as the
 * chart itself.
 *
 * The tooltip MUST wrap the chart (`<GanttTooltip><Gantt … /></Gantt>`): its core renders a
 * `.wx-tooltip-area` that resolves hovered bars by walking the event target UP to that wrapper, so
 * a sibling tooltip never fires. It takes the modal store's `api` so `data-task-id` lookups hit the
 * modal's own rows, and a custom `content` so each bar shows the module's detail card instead of
 * the vendor's default text. The inline chart is deliberately left unwrapped — its label column
 * already identifies every bar, so wrapping it would add hover noise for no gain.
 *
 * Runtime note: `Tooltip` IS in the installed bundle's exports (verified in both `dist/index.es.js`
 * and `dist/index.cjs`). The sibling `Fullscreen` is NOT — the types declare it but neither bundle
 * exports it, so importing it would render `undefined` and crash. The modal shell below is
 * therefore host-owned (see `task-gantt-modal`); only the tooltip comes from the vendor.
 */
const GanttTooltip = dynamic(
    () => import("@svar-ui/react-gantt").then((module) => module.Tooltip),
    { ssr: false },
);

/**
 * The bar label for the fullscreen chart, set as the vendor's `taskTemplate`.
 *
 * The modal chart has no label column (`columns={[]}`), so without this a bar is an anonymous
 * paint swatch. The vendor calls the template with the bar's own row and renders it INSIDE the bar
 * (or just outside it when the bar is too narrow for its content), keeping the vendor's
 * `.wx-content` class so its overflow/ellipsis rules still apply; the inner span adds the
 * truncation plus a `title` fallback for the bars that are too narrow to read.
 */
function GanttBarLabel({ data }: { readonly data: ITask }) {
    const name = data.text === undefined || data.text === "" ? `Task #${String(data.id ?? "")}` : data.text;

    return (
        <div className="wx-content">
            <span className="block truncate" title={name}>
                {name}
            </span>
        </div>
    );
}

/**
 * What the vendor's tooltip resolver can hand `content`: the task under the cursor (bars), or a
 * link / rollup / resource the modal never renders (no links, rollups or resources are passed).
 */
type GanttTooltipData =
    | { readonly task: ITask; readonly segmentIndex: number | null }
    | { readonly link: ILink }
    | { readonly rollup: ITask }
    | { readonly resource: IResource };

interface GanttTooltipCardProps {
    readonly data: GanttTooltipData;
    readonly taskById: ReadonlyMap<number, TaskListItem>;
    readonly memberNameById: ReadonlyMap<number, string>;
}

/**
 * The hover card for one bar: name, date range, status and assignees — compact, not a detail sheet.
 *
 * The store row is NOT read for these: the vendor normalises tasks into its own shape, so the card
 * looks the module row up by id and renders from `TaskListItem` (the same source the tree reads).
 * Dates go through `formatDateLong`, the module's one date format; names through `assigneeName`,
 * so an unknown member still reads as `User #<id>` instead of a blank.
 *
 * The status LABEL is always rendered beside the glyph, so meaning never depends on the
 * glyph's contrast alone.
 */
function GanttTooltipCard({ data, taskById, memberNameById }: GanttTooltipCardProps) {
    if (!("task" in data)) {
        return null;
    }

    const taskId = typeof data.task.id === "number" ? data.task.id : Number(data.task.id);
    const item = taskById.get(taskId);

    if (item === undefined) {
        return null;
    }

    const title = item.title.trim() === "" ? `Task #${item.id}` : item.title;
    const start = parseDateOnly(item.start_date);
    const end = parseDateOnly(item.end_date);

    return (
        <div className="max-w-64 space-y-1 px-2.5 py-2">
            <p className="truncate text-sm font-semibold" title={title}>
                {title}
            </p>
            {start === undefined || end === undefined ? null : (
                <p className="text-xs opacity-90">
                    {formatDateLong(start)} → {formatDateLong(end)}
                </p>
            )}
            <p className="flex items-center gap-1.5 text-xs">
                {item.status === null ? null : (
                    <CatalogStatusIcon
                        icon={item.status.icon}
                        color={item.status.color}
                        tone="status"
                        density="dense"
                    />
                )}
                <span>{item.status?.label ?? NO_STATUS_LABEL}</span>
            </p>
            {item.assignees.length === 0 ? null : (
                <p className="text-xs opacity-90">
                    {item.assignees
                        .map((assignee) => assigneeName(assignee.user_id, memberNameById))
                        .join(", ")}
                </p>
            )}
        </div>
    );
}

/**
 * A task as the chart's label-column cell sees it.
 *
 * `ITask` carries an index signature, so `statusRef` rides along through the vendor's own
 * `{ ...task }` spreads and its tree normalisation, and comes back on the `row` the cell slot is
 * handed.
 */
interface GanttTaskRow extends ITask {
    /** The task's resolved status catalog row, or `null`; the label glyph's only source. */
    readonly statusRef: TaskCatalogRef | null;
}

/** The vendor calls a label cell with the row (and column) only — see {@link GanttTaskLabelCell}. */
interface GanttTaskLabelCellProps {
    readonly row: GanttTaskRow;
}

/**
 * The label column's leading status glyph, rendered immediately before the task name.
 *
 * The vendor owns the text column: after normalising `columns` it MOVES a host-provided `cell` to
 * the column's `_cell` slot and installs its own renderer (`Nn` in `@svar-ui/react-gantt@2.7.3`),
 * which draws the tree toggle and then calls `_cell` with `{ row, column }`. Setting `cell` on the
 * `text` column is therefore the vendor's per-row label slot: the glyph lands inside the tree row,
 * after the toggle and before the name — the same `[status icon][task title]` order the tree uses.
 *
 * `statusRef` lives on the task because the vendor hands the cell the ROW only, and a module-scope
 * component cannot close over a per-render lookup from `items`.
 *
 * `tone="status"` is deliberate: the glyph sits on the label background, not on a coloured bar, so
 * it must ink itself in the status colour. It is decorative (`aria-hidden` inside
 * `CatalogStatusIcon`): the task's own data already conveys the status, exactly as in the tree.
 *
 * A `null` status renders no glyph rather than a placeholder, matching the tree.
 */
function GanttTaskLabelCell({ row }: GanttTaskLabelCellProps) {
    return (
        <span className="flex min-w-0 items-center gap-1.5">
            {row.statusRef === null ? null : (
                <CatalogStatusIcon
                    icon={row.statusRef.icon}
                    color={row.statusRef.color}
                    tone="status"
                    density="dense"
                />
            )}
            <span className="min-w-0 truncate">{row.text}</span>
        </span>
    );
}

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

    /* The hover tooltip reads these but no mounted theme defines them (the Material / Willow
       wrappers are deliberately absent), so without these declarations the tooltip would render
       with a transparent background and inherited ink. Popover tokens keep it legible in both
       app themes, matching the surfaces the app's own popovers use. The inline chart carries no
       tooltip wrapper, so these declarations change nothing there. */
    --wx-border-radius: 0.5rem;
    --wx-tooltip-background: hsl(var(--popover));
    --wx-tooltip-font-color: hsl(var(--popover-foreground));
    --wx-tooltip-border: 1px solid hsl(var(--border));
    --wx-tooltip-padding: 0.625rem 0.75rem;
    --wx-tooltip-font: var(--wx-font-weight) var(--wx-font-size-sm) var(--wx-font-family);
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

/**
 * The fullscreen chart's day-number collapse, scoped to its data-slot so the inline chart is
 * untouched.
 *
 * The vendor's default scales render month then day rows in order, so the day numbers are
 * `.wx-scale > .wx-row:last-child` and `:last-child` structurally cannot reach the month row.
 * `visibility` (not `display`) blanks the glyphs while keeping the cells, their borders and the
 * row height intact, so the header geometry never shifts under the scroll position; the today
 * tint lives on the `.wx-cell` background and survives, only its number goes quiet. Driven by
 * the host's React-held `modalCellWidth` via the `data-day-labels` marker — the vendor `zoom`
 * prop and `scales` config are not involved, zoom stays React-held.
 */
const GANTT_MODAL_DAY_LABELS_CSS = `[data-slot="task-gantt-modal-chart"][data-day-labels="hidden"] .wx-scale > .wx-row:last-child .wx-cell > span {
    visibility: hidden;
}`;

/**
 * The fullscreen chart's own height contract, scoped to its data-slot so the inline chart is
 * untouched.
 *
 * The vendor's only vertical scroller is its outer `.wx-gantt` (`height: 100%` with
 * `overflow-y: auto` in the vendor stylesheet); it overflows — and therefore scrolls — only
 * when that 100% resolves against a bounded box, with the tall `.wx-pseudo-rows` (scales
 * height plus rows times `cellHeight`) inside it. A bounded outer is self-sustaining while an
 * unbounded one is self-defeating: sized to content, nothing overflows, and the host's
 * `overflow-hidden` just clips the rows below the fold with no scrollbar. The inline box bounds
 * the chain with an explicit `h-[70vh]`; the modal box is `flex-1`, and a pure percentage chain
 * (box > `.wx-tooltip-area` with `height: 100%` > `.wx-gantt` with `height: 100%`) through a
 * flex-basis-zero item is what lets the tree size to content instead of the box. Making the box
 * a flex column (via its own class list) and the tooltip area a flex item (`flex: 1` with
 * `min-height: 0`, which also defeats the flex-item automatic minimum that would re-introduce
 * content sizing) gives the vendor subtree a definite height by flex resolution rather than
 * percentage resolution, so zooming rows to the 28px floor leaves a working vertical scroll
 * instead of unreachable rows.
 */
const GANTT_MODAL_SCROLL_CSS = `[data-slot="task-gantt-modal-chart"] .wx-tooltip-area {
    flex: 1 1 0%;
    min-height: 0;
    height: auto;
}`;

/**
 * The quieted grid, scoped to the two chart boxes' data-slots so nothing else in the app sees it.
 *
 * Two vendor facts drive this shape. First, the day/week grid behind the bars is a canvas tile
 * (`Gn` in the vendor bundle, painted by the store's grid helper): `cellBorders="column"` draws
 * the vertical date divisions only and drops the horizontal row lines — the vendor-supported
 * switch for choosing divisions, so it is passed on both charts instead of hiding internals.
 * Second, the tile's line colour is read from the computed `--wx-gantt-border` by cutting from
 * the first hash (`a.substring(a.indexOf("#"))`), which means the shared token's
 * `hsl(var(--border))` value (no hash) degrades to the canvas default — opaque black 1px lines
 * that dominate the bars. The override below is a neutral grey at ~15% alpha in hex form
 * because the extraction demands a hash; it reads as a faint picket on light themes and a
 * faint lift on dark ones. The timescale dividers are plain CSS borders, so they soften in a
 * theme-aware way instead. Bar colours, the per-task `[data-task-id]` variables, label
 * contrast, the today marker and the day-label hiding rule are not touched.
 */
const GANTT_QUIET_GRID_CSS = `[data-slot="task-gantt-chart"], [data-slot="task-gantt-modal-chart"] {
    --wx-gantt-border: 1px solid #80808026;
    --wx-timescale-border: 1px solid hsl(var(--border) / 0.45);
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

/** The vendor's own default row height (`cellHeight = 38` in `@svar-ui/react-gantt@2.7.3`). */
const GANTT_CELL_HEIGHT = 38;

/**
 * The modal's time-axis zoom limits, in pixels per day.
 *
 * These are host bounds, not the vendor's zoom levels: the chart is driven by a React-held
 * `cellWidth` prop (see the modal zoom callbacks) rather than the store's internal zoom, so the
 * store never picks its own width. 12px is the floor past which the chart would stop being a
 * timeline at all; 240px keeps a month swipeable at the close end instead of turning one week
 * into an endless scroll. A 12px step keeps the ladder coarse enough to feel like distinct zoom
 * levels rather than a continuous slider.
 */
const MODAL_MIN_CELL_WIDTH = 12;
const MODAL_MAX_CELL_WIDTH = 240;
const MODAL_CELL_WIDTH_STEP = 12;

/**
 * The narrowest day column that still shows its day number, in pixels per day.
 *
 * The timescale font is 500 12px (`--wx-timescale-font`), so a two-digit day number spans roughly
 * 14px of glyphs; centred in its cell with no side slack it touches its neighbours, and at the
 * 12px floor every label overlaps into an unreadable strip. 24px keeps ~5px of air on each side
 * of "31" — and it is exactly one zoom step above the floor, so only the floor level (and a Fit
 * result narrower than a comfortable label) renders labelless days. Below this width the modal
 * chart box carries `data-day-labels="hidden"` and the rule in `GANTT_MODAL_DAY_LABELS_CSS`
 * blanks the day-number text; the month row is never touched. Kept as a named bound next to the
 * zoom limits rather than a magic number in the trigger.
 */
const MODAL_DAY_LABEL_MIN_CELL_WIDTH = 24;

/**
 * The modal's row-height zoom limits, in pixels per row.
 *
 * 28px is the legibility floor: a bar plus its label stays readable, and the chart keeps a
 * vertical scrollbar below it instead of shrinking further. 80px keeps a zoomed-in row from
 * eating the viewport. The default is the vendor's own 38, and the 4px step keeps row growth
 * gradual next to the coarser 12px time-axis step.
 */
const MODAL_MIN_ROW_HEIGHT = 28;
const MODAL_MAX_ROW_HEIGHT = 80;
const MODAL_ROW_HEIGHT_STEP = 4;

/**
 * The vertical space Fit reserves for the chart's own chrome, in pixels.
 *
 * The modal measures its chart box and divides what remains by the row count; the scale strip and
 * the modal's gaps are vendor-internal geometry the host cannot read, so this estimate (two scale
 * rows plus padding) keeps Fit conservative rather than exact — a row too tall would overflow, a
 * row slightly short just leaves a sliver of empty chart.
 */
const MODAL_CHROME_HEIGHT = 96;

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
    /**
     * The unpadded data span: the earliest / latest instants over the actual task dates, with no
     * padding and with today deliberately NOT folded in. Fit parks and sizes from these (see
     * `fitModal`); the chart keeps rendering the padded `start` / `end` so the empty wings stay
     * reachable by month stepping. Falls back to today when no task carries a date.
     */
    readonly dataStart: Date;
    readonly dataEnd: Date;
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
    let dataMinTime: number | null = null;
    let dataMaxTime: number | null = null;

    for (const item of items) {
        const start = parseDateOnly(item.start_date);
        const end = parseDateOnly(item.end_date);

        if (start !== undefined) {
            minTime = Math.min(minTime, start.getTime());
            maxTime = Math.max(maxTime, start.getTime());
            dataMinTime = dataMinTime === null ? start.getTime() : Math.min(dataMinTime, start.getTime());
            dataMaxTime = dataMaxTime === null ? start.getTime() : Math.max(dataMaxTime, start.getTime());
        }
        if (end !== undefined) {
            minTime = Math.min(minTime, end.getTime());
            maxTime = Math.max(maxTime, end.getTime());
            dataMinTime = dataMinTime === null ? end.getTime() : Math.min(dataMinTime, end.getTime());
            dataMaxTime = dataMaxTime === null ? end.getTime() : Math.max(dataMaxTime, end.getTime());
        }
    }

    const minAnchor = shiftMonths(monthStart(new Date(minTime)), -NAVIGABLE_PADDING_MONTHS);
    const maxAnchor = shiftMonths(monthStart(new Date(maxTime)), NAVIGABLE_PADDING_MONTHS);

    return {
        start: minAnchor,
        end: monthEnd(maxAnchor),
        minAnchor,
        maxAnchor,
        // No dated task means no data span; today keeps Fit's arithmetic total without moving the
        // anchor anywhere surprising (Fit early-returns on an empty chart anyway).
        dataStart: new Date(dataMinTime ?? today.getTime()),
        dataEnd: new Date(dataMaxTime ?? today.getTime()),
    };
}

/**
 * The bar colour for one task, derived from the task's own id.
 *
 * The bar is a stable per-task visual differentiator, not a carrier of meaning: a task always has
 * exactly one id, so this is total with no "none" or "many" case to special-case, and with a finite
 * palette the colour simply repeats every `ASSIGNEE_COLOR_PALETTE.length` tasks.
 *
 * It deliberately reuses `assigneeColorFor` — a pure id -> palette mapping — so the bar applies the
 * IDENTICAL algorithm with no second palette or formula that could drift from it.
 */
function barColorFor(item: TaskListItem): string {
    return assigneeColorFor(item.id);
}

/**
 * How much of a bar's palette colour survives into its fill and border: 75%, the requested
 * translucency.
 *
 * The softness is applied to the COLOUR — `color-mix(…, transparent)` — and never as `opacity` on the
 * bar element. Element opacity would also fade the bar's label, whose ink `assigneeForegroundFor`
 * picks as a WCAG contrast decision; a softened glyph would undermine that and hurt legibility on
 * light fills. Mixing the colour itself fades the paint only and leaves the label at full contrast.
 *
 * `color-mix` is the house pattern this module already uses (see `CatalogChip`'s `DOT_HALO`); a hex
 * literal with a computed alpha is deliberately avoided so the palette stays the single colour source.
 */
const BAR_FILL_KEEP = 75;

/**
 * One CSS rule per task, keyed to the vendor's own bar variables.
 *
 * The vendor exposes no per-task colour property (its `ITask` index signature accepts an extra key
 * but ignores it), but each bar paints itself from `--wx-gantt-task-color` (plus the border/fill/font
 * companions) on an element carrying `data-task-id`. Declaring those variables ON that element beats
 * the single chart-wide declaration on `.pm-task-gantt`, because a custom property set on the node
 * itself resolves before any inherited value — genuinely per-task, not a global tint.
 *
 * The fill is `barColorFor(item)` mixed toward `transparent` (see {@link BAR_FILL_KEEP}), so bars read
 * as slightly softened rather than fully saturated. The border carries the SAME mix as the fill, so
 * the whole bar — edge included — softens together; a full-opacity border against a translucent fill
 * would trace the bar as a saturated ring, i.e. look like a rendering artefact rather than a
 * deliberately softened edge. The label ink stays `assigneeForegroundFor(hex)` — full-contrast ink
 * derived from the UN-mixed colour — because the text is the readable element and must not be
 * softened. Every task gets a rule, so no fallback path remains that could tint a bar from anything
 * but its own id.
 *
 * Fidelity note: this targets the STABLE `data-task-id` attribute, not the vendor's CSS-module class
 * hash (`.wx-GKbcLEGA`), which changes between releases.
 */
function buildBarColourCss(items: readonly TaskListItem[]): string {
    const rules: string[] = [];

    for (const item of items) {
        const hex = barColorFor(item);
        const fill = `color-mix(in srgb, ${hex} ${BAR_FILL_KEEP}%, transparent)`;
        const foreground = assigneeForegroundFor(hex);

        rules.push(
            `.pm-task-gantt [data-task-id="${item.id}"]{` +
                `--wx-gantt-task-color:${fill};` +
                `--wx-gantt-task-fill-color:${fill};` +
                `--wx-gantt-task-border:1px solid ${fill};` +
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
export function GanttView({ items, memberNameById, isLoading, error, onRetry }: TaskViewProps) {
    /**
     * The library's task list, derived in one pass from the department's flat rows. Kept as
     * `GanttTaskRow[]` (an `ITask` plus the label glyph's `statusRef`) so the `cell` slot can read
     * the status back off the row, and rebuilt only when `items` changes.
     */
    const projection = useMemo(() => {
        const tasks: GanttTaskRow[] = [];
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
                // The label glyph's source rides on the task: the vendor's cell slot hands the row
                // back to a module-scope component that cannot close over `items`.
                statusRef: item.status,
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

    /**
     * The fullscreen modal's own state. The open flag, the modal store handle, and the zoom
     * widths live here at the view level (not inside the modal) so zoom survives closing and
     * reopening; the CHART itself mounts only while the modal is open, because the vendor
     * measures its container at mount and a hidden mount mismeasures.
     *
     * Both charts share the task/range props but never a store: each mount creates its own
     * DataStore, and each `init` handle (`api` vs `modalApi`) only ever talks to its own chart.
     */
    const [modalOpen, setModalOpen] = useState(false);
    const [modalCellWidth, setModalCellWidth] = useState(GANTT_CELL_WIDTH);
    const [modalCellHeight, setModalCellHeight] = useState(GANTT_CELL_HEIGHT);
    const [modalAnchor, setModalAnchor] = useState<Date | null>(null);
    const [modalApi, setModalApi] = useState<IApi | null>(null);
    const modalChartRef = useRef<HTMLDivElement | null>(null);

    const handleModalReady = useCallback((next: IApi) => {
        setModalApi(next);
    }, []);

    /**
     * Both-axis zoom, React-controlled.
     *
     * `cellWidth` / `cellHeight` are held in state and passed as props rather than driven through
     * `api.exec("zoom-scale")`: the store re-initialises from the `start`/`end` props on re-render,
     * which would wipe store-internal zoom, while a prop survives every re-init by construction.
     */
    const zoomTimeOut = useCallback(() => {
        setModalCellWidth((width) => Math.max(MODAL_MIN_CELL_WIDTH, width - MODAL_CELL_WIDTH_STEP));
    }, []);

    const zoomTimeIn = useCallback(() => {
        setModalCellWidth((width) => Math.min(MODAL_MAX_CELL_WIDTH, width + MODAL_CELL_WIDTH_STEP));
    }, []);

    const zoomRowsOut = useCallback(() => {
        setModalCellHeight((height) =>
            Math.max(MODAL_MIN_ROW_HEIGHT, height - MODAL_ROW_HEIGHT_STEP),
        );
    }, []);

    const zoomRowsIn = useCallback(() => {
        setModalCellHeight((height) =>
            Math.min(MODAL_MAX_ROW_HEIGHT, height + MODAL_ROW_HEIGHT_STEP),
        );
    }, []);

    /**
     * Returns zoom and the anchor to the defaults, so every zoom step and Fit is reversible. The
     * anchor clears back to following the data (the inline default), because Fit parks it on the
     * data span's start month — leaving it parked would strand the next open on Fit's month.
     */
    const resetModalZoom = useCallback(() => {
        setModalCellWidth(GANTT_CELL_WIDTH);
        setModalCellHeight(GANTT_CELL_HEIGHT);
        setModalAnchor(null);
    }, []);

    /** The month the modal shows, or the inline default while Fit/an anchor has not parked it. */
    const modalVisibleMonth = modalAnchor ?? defaultAnchor;

    /**
     * The modal's month stepper, mirroring the inline `goToMonth`: the target is clamped to the
     * range's navigable bounds, so stepping can never park the chart in the empty wings past
     * `minAnchor` / `maxAnchor`.
     */
    const goToModalMonth = useCallback(
        (next: Date) => {
            const clamped = Math.min(
                Math.max(next.getTime(), range.minAnchor.getTime()),
                range.maxAnchor.getTime(),
            );
            setModalAnchor(monthStart(new Date(clamped)));
        },
        [range],
    );

    const showModalPreviousMonth = useCallback(() => {
        goToModalMonth(shiftMonths(modalVisibleMonth, -1));
    }, [goToModalMonth, modalVisibleMonth]);

    const showModalNextMonth = useCallback(() => {
        goToModalMonth(shiftMonths(modalVisibleMonth, 1));
    }, [goToModalMonth, modalVisibleMonth]);

    const showModalToday = useCallback(() => {
        goToModalMonth(monthStart(new Date()));
    }, [goToModalMonth]);

    /**
     * Fits the whole data span and row set into the modal's measured box.
     *
     * The fitted span is the UNPADDED data span (`dataStart` / `dataEnd`), not the padded range
     * the charts render: fitting the padded span would park the anchor in the empty wing (Fit
     * previously opened on `range.start`, months before the first task) and would shrink the
     * cells to cover empty months. The chart keeps rendering the padded `start` / `end` props,
     * so the wings stay reachable by month stepping. Widths are derived from the live box size,
     * then clamped to the zoom bounds — clamping is what makes Fit honest: a data span too wide
     * for the minimum cell keeps a horizontal scrollbar, and a row set too tall for the 28px
     * floor keeps a vertical one, instead of shrinking into illegibility. Few rows never stretch
     * past the default height. The anchor moves to the data span's start month so the fitted
     * view opens on the data rather than on wherever the inline chart was parked.
     */
    const fitModal = useCallback(() => {
        const node = modalChartRef.current;
        if (node === null || projection.tasks.length === 0) {
            return;
        }

        const spanDays =
            Math.ceil((range.dataEnd.getTime() - range.dataStart.getTime()) / 86400000) + 1;
        setModalCellWidth(
            Math.min(
                MODAL_MAX_CELL_WIDTH,
                Math.max(MODAL_MIN_CELL_WIDTH, Math.floor(node.clientWidth / spanDays)),
            ),
        );

        const fitRowHeight = Math.floor(
            (node.clientHeight - MODAL_CHROME_HEIGHT) / projection.tasks.length,
        );
        setModalCellHeight(
            Math.min(GANTT_CELL_HEIGHT, Math.max(MODAL_MIN_ROW_HEIGHT, fitRowHeight)),
        );
        setModalAnchor(monthStart(range.dataStart));
    }, [range, projection.tasks.length]);

    /** Module rows keyed by id, so the tooltip card renders from `TaskListItem`, not store rows. */
    const taskById = useMemo(() => {
        const map = new Map<number, TaskListItem>();
        for (const item of items) {
            map.set(item.id, item);
        }
        return map;
    }, [items]);

    /** Adapts the vendor's `{ api, data }` call into the module's tooltip card. */
    const tooltipContent = useCallback(
        ({ data }: { readonly api: IApi; readonly data: GanttTooltipData }) => (
            <GanttTooltipCard data={data} taskById={taskById} memberNameById={memberNameById} />
        ),
        [taskById, memberNameById],
    );

    const openModal = useCallback(() => {
        setModalOpen(true);
    }, []);

    const closeModal = useCallback(() => {
        setModalOpen(false);
        // Drops the unmounted chart's handle so a later open re-inits cleanly and no exec can
        // target a dead store.
        setModalApi(null);
    }, []);

    /**
     * Scrolls the modal chart onto its visible month.
     *
     * This is the minimum the modal needs for Fit to land: Fit moves the anchor AND the zoom
     * widths in one action, and this single effect is the one place that scrolls, so the two
     * agree on the final position (the data span's start) with no race. The widths are deps
     * because the store re-initialises from `start`/`end` on re-render and that resets the
     * scroll — re-running keeps the month in place across zoom steps too.
     */
    useEffect(() => {
        if (modalApi === null) {
            return;
        }

        void modalApi.exec("scroll-chart", { date: monthStart(modalVisibleMonth) });
    }, [modalApi, modalVisibleMonth, range, modalCellWidth, modalCellHeight]);

    /**
     * Closes on Escape and locks the page scroll while open. Escape never types into an input, so
     * this cannot hijack editing anywhere on the page — and no other hotkey is registered.
     */
    useEffect(() => {
        if (!modalOpen) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                closeModal();
            }
        };

        document.addEventListener("keydown", onKeyDown);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.body.style.overflow = previousOverflow;
        };
    }, [modalOpen, closeModal]);

    const showError = error !== null && error !== "";
    const isEmpty = !isLoading && !showError && projection.tasks.length === 0;
    const skipMessage = skippedLabel(projection.withoutDates, projection.invertedRange);

    /** The modal's zoom readout, matching the inline skipped line's muted status-line styling. */
    const modalZoomLabel = `Day width ${modalCellWidth} pixels, row height ${modalCellHeight} pixels`;

    /**
     * Whether the day-number row is blanked. Derived from the React-held zoom width (never the
     * vendor's internal zoom): below `MODAL_DAY_LABEL_MIN_CELL_WIDTH` the labels would overlap,
     * so the chart box carries the marker the modal day-labels rule keys off. Month labels
     * always stay.
     */
    const modalDayLabelsHidden = modalCellWidth < MODAL_DAY_LABEL_MIN_CELL_WIDTH;

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
                            ? "No tasks in this list yet."
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
            <style>{GANTT_THEME_CSS + GANTT_TODAY_CSS + GANTT_MODAL_DAY_LABELS_CSS + GANTT_MODAL_SCROLL_CSS + GANTT_QUIET_GRID_CSS + barColourRules}</style>

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

                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Open fullscreen timeline"
                    onClick={openModal}
                >
                    <Maximize2 className="size-4" aria-hidden="true" />
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
                        cannot extend past the last task and month stepping has nowhere to go.
                        `cellBorders="column"` keeps the vertical date divisions only and drops the
                        horizontal row lines — the quieted grid's vendor switch (see
                        `GANTT_QUIET_GRID_CSS`). */}
                    <GanttChart
                        tasks={projection.tasks}
                        readonly
                        autoScale={false}
                        start={range.start}
                        end={range.end}
                        cellWidth={GANTT_CELL_WIDTH}
                        cellBorders="column"
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

            {/* The explore view. Host-owned fixed overlay (the vendor's `Fullscreen` is types-only in
                the installed bundle — see `GanttTooltip`), kept inside this section so the theme,
                today-marker and per-task bar-colour rules above cascade into it. The chart mounts
                only while open so the vendor measures a laid-out box, never a hidden one. */}
            {modalOpen ? (
                <div
                    data-slot="task-gantt-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Fullscreen task timeline"
                    className="fixed inset-0 z-50 flex flex-col gap-3 bg-background/95 p-4 backdrop-blur-sm sm:p-6"
                >
                    <div
                        data-slot="task-gantt-modal-nav"
                        className="flex flex-wrap items-center justify-end gap-2"
                    >
                        {/* The modal's own month stepper, mirroring the inline chart's period
                            navigation: month stepping parks `modalAnchor`, which the shared scroll
                            effect then follows — Fit, month step and Today all flow through it. */}
                        <div
                            role="group"
                            aria-label="Timeline navigation"
                            className="flex items-center gap-2"
                        >
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label="Show the previous month"
                                onClick={showModalPreviousMonth}
                            >
                                <ChevronLeft className="size-4" aria-hidden="true" />
                            </Button>
                            <p
                                data-slot="task-gantt-modal-period"
                                aria-live="polite"
                                className="min-w-36 text-center text-sm font-medium tabular-nums text-muted-foreground"
                            >
                                {monthLabel(modalVisibleMonth)}
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label="Show the next month"
                                onClick={showModalNextMonth}
                            >
                                <ChevronRight className="size-4" aria-hidden="true" />
                            </Button>
                            <Button type="button" variant="outline" size="sm" onClick={showModalToday}>
                                <CalendarDays className="size-4" aria-hidden="true" />
                                Today
                            </Button>
                        </div>

                        {/* Time-axis and row-height steppers reuse the nav group's outline/sm
                            conventions. The pairs are distinguishable by axis: magnifiers for time,
                            vertical fold/unfold for rows — never two identical Minus/Plus pairs. */}
                        <div
                            role="group"
                            aria-label="Time axis zoom"
                            className="flex items-center gap-1"
                        >
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label="Zoom out the time axis"
                                disabled={modalCellWidth <= MODAL_MIN_CELL_WIDTH}
                                onClick={zoomTimeOut}
                            >
                                <ZoomOut className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label="Zoom in the time axis"
                                disabled={modalCellWidth >= MODAL_MAX_CELL_WIDTH}
                                onClick={zoomTimeIn}
                            >
                                <ZoomIn className="size-4" aria-hidden="true" />
                            </Button>
                        </div>

                        <div
                            role="group"
                            aria-label="Row height zoom"
                            className="flex items-center gap-1"
                        >
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label="Decrease the row height"
                                disabled={modalCellHeight <= MODAL_MIN_ROW_HEIGHT}
                                onClick={zoomRowsOut}
                            >
                                <FoldVertical className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label="Increase the row height"
                                disabled={modalCellHeight >= MODAL_MAX_ROW_HEIGHT}
                                onClick={zoomRowsIn}
                            >
                                <UnfoldVertical className="size-4" aria-hidden="true" />
                            </Button>
                        </div>

                        <Button type="button" variant="outline" size="sm" onClick={fitModal}>
                            Fit
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={resetModalZoom}>
                            <RotateCcw className="size-4" aria-hidden="true" />
                            Reset
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label="Close the fullscreen timeline"
                            onClick={closeModal}
                            autoFocus
                        >
                            <X className="size-4" aria-hidden="true" />
                        </Button>
                    </div>

                    <div
                        data-slot="task-gantt-modal-chart"
                        ref={modalChartRef}
                        data-day-labels={modalDayLabelsHidden ? "hidden" : "shown"}
                        className="pm-task-gantt flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm"
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
                            {/* Same read-only contract as the inline chart, plus the modal's
                                differences: no label column (bar labels + tooltip identify bars),
                                the bar-name template, column-only background grid lines (the day
                                divisions without the row lines, which the quieted grid tokens then
                                soften — see `GANTT_QUIET_GRID_CSS`), and its own `init` handle on
                                its own store. `modalApi` starts null so the wrapping tooltip simply
                                stays quiet until the chart reports ready. */}
                            <GanttTooltip api={modalApi ?? undefined} content={tooltipContent}>
                                {/* The modal chart takes the React-held zoom widths. The inline chart
                                    above keeps its fixed values: zoom is a modal-only concern, and
                                    holding it in props (not store-internal zoom) is what survives the
                                    store re-init from `start`/`end` — see the zoom callbacks. */}
                                <GanttChart
                                    tasks={projection.tasks}
                                    readonly
                                    autoScale={false}
                                    start={range.start}
                                    end={range.end}
                                    cellWidth={modalCellWidth}
                                    cellHeight={modalCellHeight}
                                    columns={[]}
                                    cellBorders="column"
                                    taskTemplate={GanttBarLabel}
                                    highlightTime={highlightToday}
                                    init={handleModalReady}
                                />
                            </GanttTooltip>
                        </GanttErrorBoundary>
                    </div>

                    <p
                        data-slot="task-gantt-modal-status"
                        className="text-center text-xs text-muted-foreground"
                        aria-live="polite"
                    >
                        {modalZoomLabel}
                    </p>
                </div>
            ) : null}
        </section>
    );
}

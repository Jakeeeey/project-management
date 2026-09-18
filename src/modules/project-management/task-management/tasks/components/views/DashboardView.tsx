"use client";

import { useMemo, useState } from "react";
import { AlarmClock, CalendarOff, ChartColumn, ChartNoAxesColumn, ClipboardList, ListTree, PieChart as PieChartIcon, RotateCcw, TriangleAlert, UserX, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatDateLong, formatNumber } from "@/lib/utils";

import { assigneeName, type TaskViewProps } from "../../types/task-view";
import { parseDateOnly } from "../SingleDatePicker";

/**
 * The Dashboard view of the tasks page: read-only analytics over the department's already-fetched
 * rows.
 *
 * It is presentational by contract — it receives the flat rows, both catalogs and the member
 * directory, derives every number itself, and never fetches or writes. Nothing here is clickable
 * except the error panel's retry, which only asks the shell to refetch.
 *
 * Two semantic choices are deliberate, because the wire carries no completion model:
 * — "Past due" counts any row whose `end_date` is before today **and** whose `status` resolves.
 *   The department's terminal/complete status is data the view does not have, so instead of guessing
 *   a label such as "Done", the tile is named honestly and says so in its own subtitle. A row with
 *   an unresolved status is excluded, because "overdue" is meaningless without a status.
 * — "No dates" means NEITHER a start NOR an end date, not "some date is missing".
 *
 * @param props - the frozen `TaskViewProps` contract; the shell passes already-fetched data.
 */
export function DashboardView({
    items,
    catalogs,
    memberNameById,
    isLoading,
    error,
    onRetry,
}: TaskViewProps) {
    /**
     * One local-midnight instant, captured once for the life of the view.
     *
     * `parseDateOnly` yields a local-midnight `Date`, so the overdue comparison has to be made at
     * the same granularity — comparing against a wall-clock `new Date()` would mark a task due
     * TODAY as already past due. Held in state so the value is a stable primitive the memo can
     * depend on, and so the whole derivation reads "today" from one place instead of per row.
     */
    const [todayStartMs] = useState(() => {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    });

    const stats = useMemo(() => {
        const byStatusId = new Map<number, number>();
        const byPriorityId = new Map<number, number>();
        const byAssigneeId = new Map<number, number>();

        let unassignedCount = 0;
        let noDateCount = 0;
        let pastDueCount = 0;
        let assignmentCount = 0;

        // One pass over the rows: the tiles, the three charts and the footer all read the same
        // counters, so no two numbers on this view can be derived from different scans.
        for (const task of items) {
            byStatusId.set(task.status_id, (byStatusId.get(task.status_id) ?? 0) + 1);
            byPriorityId.set(task.priority_id, (byPriorityId.get(task.priority_id) ?? 0) + 1);

            if (task.assignees.length === 0) {
                unassignedCount += 1;
            } else {
                for (const assignee of task.assignees) {
                    byAssigneeId.set(assignee.user_id, (byAssigneeId.get(assignee.user_id) ?? 0) + 1);
                    assignmentCount += 1;
                }
            }

            if (!hasDate(task.start_date) && !hasDate(task.end_date)) noDateCount += 1;

            const endDate = parseDateOnly(task.end_date);
            if (endDate !== undefined && endDate.getTime() < todayStartMs && task.status !== null) {
                pastDueCount += 1;
            }
        }

        // One bar per catalog row, in catalog order, so the chart reads like the Board's columns.
        const statusData: ChartDatum[] = catalogs.statuses.map((status, index) => ({
            configKey: `status-${status.id}`,
            label: labelOrFallback(status.label, `Status #${status.id}`),
            value: byStatusId.get(status.id) ?? 0,
            fill: status.color ?? seriesFallback(index),
        }));

        const priorityData: ChartDatum[] = catalogs.priorities.map((priority, index) => ({
            configKey: `priority-${priority.id}`,
            label: labelOrFallback(priority.label, `Priority #${priority.id}`),
            value: byPriorityId.get(priority.id) ?? 0,
            fill: priority.color ?? seriesFallback(index),
        }));

        // Heaviest workload first; the unassigned tail is appended after the sort so it stays last
        // even when it is the largest bucket — the same convention the Team view uses.
        const assigneeData: ChartDatum[] = [...byAssigneeId.entries()]
            .map(([userId, value]) => ({ userId, value, name: assigneeName(userId, memberNameById) }))
            .sort((a, b) => b.value - a.value || compareLabels(a.name, b.name))
            .map((row, index) => ({
                configKey: `assignee-${row.userId}`,
                label: row.name,
                value: row.value,
                fill: seriesFallback(index),
            }));

        if (unassignedCount > 0) {
            assigneeData.push({
                configKey: "assignee-unassigned",
                label: "Unassigned",
                value: unassignedCount,
                fill: "var(--color-muted-foreground)",
            });
        }

        return {
            total: items.length,
            unassignedCount,
            noDateCount,
            pastDueCount,
            assignmentCount,
            statusData,
            priorityData,
            assigneeData,
            // How many rows each chart actually covers — a row whose catalog reference no longer
            // resolves cannot appear on a bar, so the footer states the covered totals explicitly.
            statusCovered: sumValues(statusData),
            priorityCovered: sumValues(priorityData),
            statusConfig: buildConfig(statusData),
            priorityConfig: buildConfig(priorityData),
            assigneeConfig: buildConfig(assigneeData),
        };
    }, [items, catalogs, memberNameById, todayStartMs]);

    if (isLoading) return <DashboardSkeleton />;

    if (error !== null && error !== "") {
        return (
            <div
                data-slot="task-dashboard-error"
                role="alert"
                className="flex h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
            >
                <TriangleAlert className="size-8 text-destructive" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Try again
                </Button>
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div
                data-slot="task-dashboard-empty"
                className="flex h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
            >
                <ListTree className="size-8 text-muted-foreground/50" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">No tasks in this department yet.</p>
            </div>
        );
    }

    return (
        <div data-slot="task-dashboard" className="w-full min-w-0 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <KpiTile icon={ClipboardList} label="Total tasks" value={stats.total} />
                <KpiTile
                    icon={UserX}
                    label="Unassigned"
                    value={stats.unassignedCount}
                    note="No assignee on the task."
                />
                <KpiTile
                    icon={CalendarOff}
                    label="No dates"
                    value={stats.noDateCount}
                    note="Neither a start nor an end date."
                />
                <KpiTile
                    icon={AlarmClock}
                    label="Past due"
                    value={stats.pastDueCount}
                    note="End date before today, whatever the status."
                    title="Counts every task with an end date before today whose status is set. The department's completion model is not assumed, so completed work is not excluded."
                />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <ChartCard
                    icon={ChartColumn}
                    title="Tasks by status"
                    description="One bar per status in this department's catalog."
                >
                    {stats.statusCovered === 0 ? (
                        <NoDataPanel />
                    ) : (
                        <CategoryBarChart
                            data={stats.statusData}
                            config={stats.statusConfig}
                            chartLabel="Tasks by status"
                        />
                    )}
                </ChartCard>

                <ChartCard
                    icon={PieChartIcon}
                    title="Tasks by priority"
                    description="One segment per priority in this department's catalog."
                >
                    {stats.priorityCovered === 0 ? (
                        <NoDataPanel />
                    ) : (
                        <PriorityDonut
                            data={stats.priorityData}
                            config={stats.priorityConfig}
                            chartLabel="Tasks by priority"
                        />
                    )}
                </ChartCard>

                <ChartCard
                    icon={Users}
                    title="Tasks per assignee"
                    description="Workload distribution — a shared task counts once for each assignee."
                    className="lg:col-span-2"
                >
                    {stats.assigneeData.length === 0 ? (
                        <NoDataPanel />
                    ) : (
                        <CategoryBarChart
                            data={stats.assigneeData}
                            config={stats.assigneeConfig}
                            chartLabel="Tasks per assignee"
                        />
                    )}
                </ChartCard>
            </div>

            <p data-slot="task-dashboard-footer" className="text-xs text-muted-foreground">
                Snapshot as of {formatDateLong(new Date(todayStartMs))} — built from{" "}
                <Metric>{countText(stats.total)}</Metric> tasks
                <span aria-hidden="true"> · </span>
                <Metric>{countText(stats.statusCovered)}</Metric> with a live status
                <span aria-hidden="true"> · </span>
                <Metric>{countText(stats.priorityCovered)}</Metric> with a live priority
                <span aria-hidden="true"> · </span>
                <Metric>{countText(stats.assignmentCount)}</Metric> assignee links across{" "}
                <Metric>{countText(stats.total - stats.unassignedCount)}</Metric> assigned tasks (a
                shared task counts once per assignee).
            </p>
        </div>
    );
}

/** One chart row: a stable config key, the display label, the count and the resolved fill. */
interface ChartDatum {
    /** Unique per series and stable across renders — the `ChartConfig` key and the React/Cell key. */
    readonly configKey: string;
    readonly label: string;
    readonly value: number;
    /** A stored catalog hex or a theme token — never a light-only literal. */
    readonly fill: string;
}

/**
 * Fallback series colours.
 *
 * Used by catalog rows that carry no stored hex and by every assignee bar, which has no colour of
 * its own. Every entry is a theme token, so the bars stay legible when `.dark` remaps the palette;
 * a hardcoded light-only hex would disappear against a dark card.
 */
const SERIES_FALLBACK_COLORS: readonly string[] = [
    "var(--color-primary)",
    "var(--color-info)",
    "var(--color-success)",
    "var(--color-warning)",
    "var(--color-accent-foreground)",
];

/** The value-end rounding of a horizontal bar, as `[topLeft, topRight, bottomRight, bottomLeft]`. */
const HORIZONTAL_BAR_RADIUS: [number, number, number, number] = [0, 6, 6, 0];

/** Room reserved for the category labels on the value axis' left; long names are truncated to fit. */
const CATEGORY_AXIS_WIDTH = 116;

/** A count with no decimals — the tiles, the legend and the footer all read the same way. */
function countText(value: number): string {
    return formatNumber(value, "en-PH", 0);
}

/** `true` only for a non-blank date string; the hook already collapses `""` to `null`. */
function hasDate(value: string | null): boolean {
    return value !== null && value.trim() !== "";
}

/** A catalog label, or a stable placeholder when the stored label is blank. */
function labelOrFallback(label: string, fallback: string): string {
    return label.trim() === "" ? fallback : label;
}

/** Cycles the theme-token palette so an unbounded series count can never run out of colours. */
function seriesFallback(index: number): string {
    return SERIES_FALLBACK_COLORS[index % SERIES_FALLBACK_COLORS.length];
}

/** A stable, locale-aware title ordering — the same comparator the Team view uses. */
function compareLabels(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** The sum of every bar/segment, i.e. how many rows the chart actually covers. */
function sumValues(data: readonly ChartDatum[]): number {
    let total = 0;
    for (const datum of data) total += datum.value;
    return total;
}

/** Indexes the datums by their config key so the tooltip can resolve a label and colour. */
function buildConfig(data: readonly ChartDatum[]): ChartConfig {
    const config: ChartConfig = {};
    for (const datum of data) {
        config[datum.configKey] = { label: datum.label, color: datum.fill };
    }
    return config;
}

/** A tall-enough plot for the row count, capped so a large department cannot dominate the page. */
function chartHeight(rowCount: number): number {
    const rows = Math.max(rowCount, 1);
    return Math.min(Math.max(rows * 30 + 28, 160), 460);
}

/** Trims a category label for the axis; recharts does not wrap, so overflow must be prevented. */
function truncateTick(value: unknown): string {
    const text = typeof value === "string" ? value : String(value ?? "");
    return text.length <= 16 ? text : `${text.slice(0, 15)}…`;
}

/** The accessibility text for a chart, since the SVG itself holds no readable values. */
function summarise(chartLabel: string, data: readonly ChartDatum[]): string {
    const parts = data.map((datum) => `${datum.label}: ${countText(datum.value)}`);
    return parts.length === 0 ? `${chartLabel}: no data` : `${chartLabel}. ${parts.join(", ")}.`;
}

interface KpiTileProps {
    icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
    label: string;
    value: number;
    /** One short line explaining exactly what the number counts, shown under the value. */
    note?: string;
    title?: string;
}

/** One KPI tile: its label, its count and — where the semantics need it — an honest footnote. */
function KpiTile({ icon: Icon, label, value, note, title }: KpiTileProps) {
    return (
        <div
            data-slot="task-dashboard-kpi"
            title={title}
            className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border/50 bg-card p-4 shadow-sm"
        >
            <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
                <Icon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
            </div>
            <span className="text-2xl font-semibold tabular-nums">{countText(value)}</span>
            {note === undefined ? null : (
                <span className="text-[11px] leading-snug text-muted-foreground">{note}</span>
            )}
        </div>
    );
}

interface ChartCardProps {
    icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
    title: string;
    description: string;
    className?: string;
    children: React.ReactNode;
}

/** One chart's card: a heading that says what the bars mean, then the plot itself. */
function ChartCard({ icon: Icon, title, description, className, children }: ChartCardProps) {
    return (
        <section
            data-slot="task-dashboard-chart-card"
            className={cn(
                "flex min-w-0 flex-col gap-4 rounded-2xl border border-border/50 bg-card p-4 shadow-sm",
                className,
            )}
        >
            <header className="flex items-start gap-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold">{title}</h3>
                    <p className="text-xs text-muted-foreground">{description}</p>
                </div>
            </header>
            <div className="min-w-0">{children}</div>
        </section>
    );
}

interface CategoryBarChartProps {
    data: ChartDatum[];
    config: ChartConfig;
    /** The chart's name, also the prefix of its accessibility summary. */
    chartLabel: string;
}

/** A horizontal bar chart: one bar per catalog row (or per assignee), labels on the left. */
function CategoryBarChart({ data, config, chartLabel }: CategoryBarChartProps) {
    return (
        <ChartContainer
            config={config}
            role="img"
            aria-label={summarise(chartLabel, data)}
            className="aspect-auto w-full"
            style={{ height: chartHeight(data.length) }}
        >
            <BarChart
                data={data}
                layout="vertical"
                margin={{ top: 4, right: 20, bottom: 4, left: 0 }}
                barCategoryGap={6}
            >
                <CartesianGrid horizontal={false} stroke="var(--color-border)" />
                <XAxis type="number" dataKey="value" allowDecimals={false} tickLine={false} axisLine={false} />
                <YAxis
                    type="category"
                    dataKey="label"
                    width={CATEGORY_AXIS_WIDTH}
                    interval={0}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={truncateTick}
                />
                <ChartTooltip
                    content={<ChartTooltipContent nameKey="configKey" hideLabel indicator="dot" />}
                />
                <Bar dataKey="value" maxBarSize={22} radius={HORIZONTAL_BAR_RADIUS}>
                    {data.map((datum) => (
                        <Cell key={datum.configKey} fill={datum.fill} />
                    ))}
                </Bar>
            </BarChart>
        </ChartContainer>
    );
}

interface PriorityDonutProps {
    data: ChartDatum[];
    config: ChartConfig;
    chartLabel: string;
}

/**
 * A donut plus an explicit legend.
 *
 * The legend is rendered here rather than through `ChartLegend` because each priority's count has to
 * sit next to its label — the donut shows the split, the legend makes it auditable.
 */
function PriorityDonut({ data, config, chartLabel }: PriorityDonutProps) {
    return (
        <div className="flex min-w-0 flex-col items-center gap-4 sm:flex-row">
            <ChartContainer
                config={config}
                role="img"
                aria-label={summarise(chartLabel, data)}
                className="aspect-auto h-[200px] w-full max-w-[220px] shrink-0"
            >
                <PieChart>
                    <ChartTooltip
                        cursor={false}
                        content={<ChartTooltipContent nameKey="configKey" hideLabel indicator="dot" />}
                    />
                    <Pie
                        data={data}
                        dataKey="value"
                        nameKey="configKey"
                        innerRadius="58%"
                        outerRadius="88%"
                        paddingAngle={2}
                        stroke="none"
                    >
                        {data.map((datum) => (
                            <Cell key={datum.configKey} fill={datum.fill} />
                        ))}
                    </Pie>
                </PieChart>
            </ChartContainer>

            <ul className="w-full min-w-0 flex-1 space-y-2">
                {data.map((datum) => (
                    <li key={datum.configKey} className="flex min-w-0 items-center gap-2 text-sm">
                        <span
                            className="size-2.5 shrink-0 rounded-[3px]"
                            style={{ backgroundColor: datum.fill }}
                            aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate" title={datum.label}>
                            {datum.label}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                            {countText(datum.value)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The stand-in for a chart whose rows carry nothing to plot — never an axis without data. */
function NoDataPanel() {
    return (
        <div
            data-slot="task-dashboard-no-data"
            className="flex h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/20 p-6 text-center"
        >
            <ChartNoAxesColumn className="size-7 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">No data yet</p>
        </div>
    );
}

/** A small emphasised value inside the footer sentence. */
function Metric({ children }: { children: React.ReactNode }) {
    return <span className="font-medium tabular-nums text-foreground">{children}</span>;
}

/** Fixed placeholder keys — the catalogs are empty during a cold load, so they cannot shape this. */
const SKELETON_KPIS: readonly string[] = ["one", "two", "three", "four"];

/** The dashboard's cold-load skeleton, shaped like the tiles and the three chart cards. */
function DashboardSkeleton() {
    return (
        <div
            data-slot="task-dashboard-loading"
            role="status"
            aria-label="Loading tasks"
            className="w-full min-w-0 space-y-4"
        >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {SKELETON_KPIS.map((kpi) => (
                    <Skeleton key={kpi} className="h-[104px] rounded-2xl" />
                ))}
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Skeleton className="h-[300px] rounded-2xl" />
                <Skeleton className="h-[300px] rounded-2xl" />
                <Skeleton className="h-[300px] rounded-2xl lg:col-span-2" />
            </div>
            <span className="sr-only">Loading tasks…</span>
        </div>
    );
}

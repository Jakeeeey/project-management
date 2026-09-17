"use client";

import type { CSSProperties, ReactNode, Ref } from "react";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn, formatDateLong } from "@/lib/utils";
import type { TreeNode } from "@/modules/project-management/utils/tree";

import { AssigneeStack, type TaskAssigneeView } from "./AssigneeStack";
import { parseDateOnly } from "./SingleDatePicker";
import {
    TaskPriorityBadge,
    TaskStatusBadge,
    type TaskCatalogRef,
} from "./TaskRowBadges";
import type { TaskField, TaskFieldValue } from "../hooks/useTasks";

/**
 * Everything a single row renders. Structurally satisfies `TreeSourceRow`, so `buildTree` can
 * enrich it with the computed `depth` and `children` the row is rendered from.
 *
 * Status and priority arrive already resolved (or `null` when the referenced catalog row is not
 * live) — the row never looks a label up itself.
 */
export interface TaskRowView {
    id: number;
    parent_id: number | null;
    sort_order: number;
    title: string;
    start_date: string | null;
    end_date: string | null;
    status: TaskCatalogRef | null;
    priority: TaskCatalogRef | null;
    assignees: readonly TaskAssigneeView[];
    /** This task's answers for the department's custom columns; a column with no answer is absent. */
    custom_values: readonly TaskFieldValue[];
}

/**
 * The visual indent stops deepening after this level; deeper rows stay flush.
 *
 * This is presentation only. `aria-level` keeps reading the true computed depth, so a level-12
 * row is still announced as level 12 even though its gutter looks the same as a level-8 row.
 */
export const MAX_INDENT_DEPTH = 8;

/** Pixels of left gutter per level of visual indent. */
export const INDENT_STEP_PX = 20;

/**
 * A `YYYY-MM-DD` task date as long-form display text.
 *
 * Parsing goes through `parseDateOnly` (local calendar parts), not `new Date(value)` — a bare
 * date-only string is read as UTC midnight, which would render the previous day west of UTC. A
 * missing or malformed value renders an em dash rather than an empty cell.
 */
export function formatTaskDate(value: string | null | undefined): string {
    const date = parseDateOnly(value);
    return date === undefined ? "—" : formatDateLong(date);
}

/** Short month names, indexed by `Date.getMonth()`. A literal table, not `Intl` — see conventions §19. */
const MONTH_ABBREVIATIONS: readonly string[] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** A `YYYY-MM-DD` task date as short display text (`Sep 17, 2026`); `—` when missing or malformed. */
export function formatTaskDateCompact(value: string | null | undefined): string {
    const date = parseDateOnly(value);
    if (date === undefined) return "—";
    return `${MONTH_ABBREVIATIONS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * The start/end pair as one compact label. A one-sided range renders the side that exists and an
 * identical pair collapses to a single date — which is what lets the table carry ONE dates column
 * instead of two full-date columns that each had to truncate.
 */
export function formatTaskDateRange(
    start: string | null | undefined,
    end: string | null | undefined,
): string {
    const startDate = parseDateOnly(start);
    const endDate = parseDateOnly(end);

    if (startDate === undefined && endDate === undefined) return "—";
    if (endDate === undefined) return formatTaskDateCompact(start);
    if (startDate === undefined) return formatTaskDateCompact(end);

    const startText = formatTaskDateCompact(start);
    const endText = formatTaskDateCompact(end);
    return startText === endText ? startText : `${startText} – ${endText}`;
}

/**
 * One custom-column answer as display text.
 *
 * A `select` renders its choice's label, so a rename is reflected without touching a task row. A
 * stored id whose choice is no longer live renders the removed-choice placeholder rather than the
 * bare number — the same rule the status and priority badges follow for an unresolved reference.
 * A blank answer renders an em dash.
 */
export function formatTaskFieldValue(field: TaskField, value: string | null | undefined): string {
    if (value === null || value === undefined || value === "") return "—";
    if (field.field_type !== "select") return value;
    const option = field.options.find((candidate) => String(candidate.id) === value);
    return option?.label ?? "Removed choice";
}

export interface TaskRowProps {
    /** The assembled node — `depth` is the true level and drives both `aria-level` and the gutter. */
    node: TreeNode<TaskRowView>;
    /** 1-based position among this node's siblings (`aria-posinset`). */
    posInSet: number;
    /** Number of siblings at this node's level (`aria-setsize`), taken from the full tree. */
    setSize: number;
    hasChildren: boolean;
    isExpanded: boolean;
    onToggleExpand: (id: number) => void;
    /**
     * Slot for the dnd-kit handle (todo 6). Kept as a prop so the row itself stays presentational
     * and never imports drag machinery — a row rendered without it is still a valid row.
     */
    dragHandle?: ReactNode;
    /** Slot for the row's overflow menu / actions. */
    actions?: ReactNode;
    /** The department's custom columns, rendered as extra cells after the dates column. */
    fields?: readonly TaskField[];
    /**
     * Forwarded to the underlying `<tr>` so a sortable wrapper (todo 6) can measure and transform
     * the row. Absent for a plain render, which keeps the row presentational.
     */
    rowRef?: Ref<HTMLTableRowElement>;
    /** Inline transform/transition from `useSortable`; empty for a plain render. */
    rowStyle?: CSSProperties;
    /** Drop-indicator / drag-state classes merged onto the row — the row supplies nothing itself. */
    rowClassName?: string;
}

/**
 * One tree row: a leading expand/collapse cell, the indented title, then the data cells.
 *
 * The expand chevron only renders for a node with children; a leaf keeps the same leading width
 * via an aria-hidden spacer so titles stay aligned across a level. Every text-bearing cell wraps
 * its value in a `max-w-* truncate` span (plus `title`) so a long value can neither push its
 * neighbours nor force the table wider than its own horizontal scroll.
 */
export function TaskRow({
    node,
    posInSet,
    setSize,
    hasChildren,
    isExpanded,
    onToggleExpand,
    dragHandle,
    actions,
    fields = [],
    rowRef,
    rowStyle,
    rowClassName,
}: TaskRowProps) {
    const indentDepth = Math.min(node.depth, MAX_INDENT_DEPTH);
    const subtaskCount = node.children.length;
    const subtaskLabel = `${subtaskCount} sub-task${subtaskCount === 1 ? "" : "s"}`;
    const expandLabel = isExpanded ? `Collapse ${node.title}` : `Expand ${node.title}`;
    const rangeText = formatTaskDateRange(node.start_date, node.end_date);
    const rangeTitle = `Start: ${formatTaskDate(node.start_date)} · Due: ${formatTaskDate(node.end_date)}`;

    return (
        <TableRow
            ref={rowRef}
            style={rowStyle}
            role="row"
            data-slot="task-tree-row"
            data-task-id={node.id}
            data-depth={node.depth}
            data-indent-depth={indentDepth}
            aria-level={node.depth + 1}
            aria-posinset={posInSet}
            aria-setsize={setSize}
            aria-expanded={hasChildren ? isExpanded : undefined}
            className={cn("group", rowClassName)}
        >
            <TableCell className="w-[76px]">
                <div className="flex items-center gap-1">
                    {dragHandle}
                    {hasChildren ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={expandLabel}
                            title={expandLabel}
                            aria-expanded={isExpanded}
                            data-slot="task-tree-expand"
                            onClick={() => onToggleExpand(node.id)}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                        >
                            <ChevronRight
                                className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")}
                                aria-hidden="true"
                            />
                        </Button>
                    ) : (
                        <span className="size-6 shrink-0" aria-hidden="true" />
                    )}
                </div>
            </TableCell>

            <TableCell className="max-w-[360px]">
                <div className="flex items-center gap-1.5" style={{ paddingLeft: indentDepth * INDENT_STEP_PX }}>
                    <span className="block max-w-[320px] truncate font-medium" title={node.title}>
                        {node.title}
                    </span>
                    {subtaskCount > 0 ? (
                        <Badge
                            variant="secondary"
                            data-slot="task-subtask-count"
                            title={subtaskLabel}
                            className="shrink-0 border-border/60 px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground"
                        >
                            <span aria-hidden="true">{subtaskCount}</span>
                            <span className="sr-only">{subtaskLabel}</span>
                        </Badge>
                    ) : null}
                </div>
            </TableCell>

            <TableCell className="max-w-[160px]">
                <TaskStatusBadge status={node.status} />
            </TableCell>

            <TableCell className="max-w-[160px]">
                <TaskPriorityBadge priority={node.priority} />
            </TableCell>

            <TableCell className="max-w-[180px]">
                <AssigneeStack assignees={node.assignees} />
            </TableCell>

            <TableCell className="max-w-[190px]">
                <span className="block truncate text-muted-foreground" title={rangeTitle}>
                    {rangeText}
                </span>
            </TableCell>

            {fields.map((field) => {
                const answer =
                    node.custom_values.find((entry) => entry.field_id === field.id)?.value ?? null;
                const text = formatTaskFieldValue(field, answer);
                return (
                    <TableCell key={field.id} className="max-w-[170px]">
                        <span className="block truncate text-muted-foreground" title={text}>
                            {text}
                        </span>
                    </TableCell>
                );
            })}

            <TableCell className="w-[72px] text-right">
                {actions ?? <span className="sr-only">No actions available</span>}
            </TableCell>
        </TableRow>
    );
}

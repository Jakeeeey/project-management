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
    rowRef,
    rowStyle,
    rowClassName,
}: TaskRowProps) {
    const indentDepth = Math.min(node.depth, MAX_INDENT_DEPTH);
    const subtaskCount = node.children.length;
    const subtaskLabel = `${subtaskCount} sub-task${subtaskCount === 1 ? "" : "s"}`;
    const expandLabel = isExpanded ? `Collapse ${node.title}` : `Expand ${node.title}`;
    const startText = formatTaskDate(node.start_date);
    const endText = formatTaskDate(node.end_date);

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

            <TableCell className="max-w-[160px]">
                <span className="block max-w-[140px] truncate text-muted-foreground" title={startText}>
                    {startText}
                </span>
            </TableCell>

            <TableCell className="max-w-[160px]">
                <span className="block max-w-[140px] truncate text-muted-foreground" title={endText}>
                    {endText}
                </span>
            </TableCell>

            <TableCell className="w-[72px] text-right">
                {actions ?? <span className="sr-only">No actions available</span>}
            </TableCell>
        </TableRow>
    );
}

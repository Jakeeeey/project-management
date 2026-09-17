"use client";

import { useCallback, type CSSProperties, type ReactNode, type Ref } from "react";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn, formatDateLong } from "@/lib/utils";
import { CatalogChip } from "@/modules/project-management/components/CatalogChip";
import type { TreeNode } from "@/modules/project-management/utils/tree";

import { AssigneeStack, type TaskAssigneeView } from "./AssigneeStack";
import { parseDateOnly } from "./SingleDatePicker";
import {
    TaskCellEditor,
    type CellEditRequest,
    type CellMemberOption,
} from "./TaskCellEditor";
import {
    TaskPriorityBadge,
    TaskStatusBadge,
    type TaskCatalogRef,
} from "./TaskRowBadges";
import type { TaskCatalogs, TaskField, TaskFieldValue } from "../hooks/useTasks";

/**
 * Everything a single row renders. Structurally satisfies `TreeSourceRow`, so `buildTree` can
 * enrich it with the computed `depth` and `children` the row is rendered from.
 *
 * Status and priority arrive already resolved (or `null` when the referenced catalog row is not
 * live) — the row never looks a label up itself. The ids ride along anyway: the in-place editor
 * needs them to open the picker on the row's current value.
 */
export interface TaskRowView {
    id: number;
    parent_id: number | null;
    sort_order: number;
    title: string;
    start_date: string | null;
    end_date: string | null;
    status_id: number;
    priority_id: number;
    status: TaskCatalogRef | null;
    priority: TaskCatalogRef | null;
    assignees: readonly TaskAssigneeView[];
    /** This task's answers for the department's custom columns; a column with no answer is absent. */
    custom_values: readonly TaskFieldValue[];
    /** The server's per-row edit answer — the only thing an edit affordance may be gated on. */
    can_edit: boolean;
}

/**
 * A row's optimistic display patch for the one cell being saved.
 *
 * A cell commits in place, so the row must show the new value while the write is in flight — this
 * is the ONE deliberate exception to the module's "no optimistic patching" rule. The module drops
 * the patch once its refetch (or its failure) has produced the server's answer, which is what makes
 * a failed save revert.
 */
export interface TaskRowPatch {
    title?: string;
    status?: TaskCatalogRef | null;
    priority?: TaskCatalogRef | null;
    assignees?: readonly TaskAssigneeView[];
    start_date?: string | null;
    end_date?: string | null;
    custom_values?: readonly TaskFieldValue[];
}

/** The patch's value for a key, or the row's own when the key is absent (a `null` is a real value). */
function patched<T>(patch: TaskRowPatch | undefined, key: keyof TaskRowPatch, fallback: T): T {
    if (patch === undefined) return fallback;
    const value: unknown = patch[key];
    return value === undefined ? fallback : (value as T);
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
 * The start/end pair as one compact label for the read-only views. A one-sided range renders the
 * side that exists and an identical pair collapses to a single date. The editable task table does
 * NOT use this: it renders the two sides as separate, independently editable columns.
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

/** The one display geometry of an editable cell's hit target: full-cell, left-aligned, quiet until hover. */
const CELL_BUTTON_CLASS =
    "block w-full min-w-0 rounded px-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/** A custom `select` answer as the module's chip: a live choice tints from its own colour. */
function FieldChoiceChip({ field, value }: { field: TaskField; value: string | null }) {
    const option =
        value === null || value === ""
            ? undefined
            : field.options.find((candidate) => String(candidate.id) === value);

    if (option === undefined) {
        return (
            <CatalogChip
                value={null}
                placeholder={value === null || value === "" ? "Not set" : "Removed choice"}
                density="dense"
                className="max-w-[140px]"
                data-slot={`task-field-${field.id}-badge`}
            />
        );
    }

    return (
        <CatalogChip
            value={{ label: option.label, color: option.color }}
            density="dense"
            className="max-w-[140px]"
            data-slot={`task-field-${field.id}-badge`}
        />
    );
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
    /** The department's custom columns, rendered as extra cells after the due column. */
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
    /** The department's catalogs — the status/priority editors' only source of options. */
    catalogs?: TaskCatalogs;
    members?: readonly CellMemberOption[];
    /**
     * The single cell currently being edited anywhere in the table (`{ taskId, column }`), or `null`.
     * Kept on the module so only ONE cell is ever open; a second click replaces it.
     */
    editingCell?: { readonly taskId: number; readonly column: string } | null;
    /** Optimistic display patches, keyed `"<taskId>:<column>"` — empty when nothing is saving. */
    cellPatches?: ReadonlyMap<string, TaskRowPatch>;
    /** Opens this row's cell editor. Absent (or `can_edit: false`) renders no edit affordance. */
    onStartCellEdit?: (taskId: number, column: string) => void;
    /** Leaves the open editor without writing. */
    onCancelCellEdit?: () => void;
    /** Saves one cell edit through the module's existing mutation path. */
    onCommitCellEdit?: (taskId: number, column: string, request: CellEditRequest) => void;
}

/**
 * One tree row: a leading expand/collapse cell, the indented title, then the data cells.
 *
 * The expand chevron only renders for a node with children; a leaf keeps the same leading width
 * via an aria-hidden spacer so titles stay aligned across a level. Every text-bearing cell wraps
 * its value in a `max-w-* truncate` span (plus `title`) so a long value can neither push its
 * neighbours nor force the table wider than its own horizontal scroll.
 *
 * When the server says the row `can_edit`, each data cell becomes an editable cell: clicking it
 * swaps the display for the column's own picker (see `TaskCellEditor`), and the row shows the new
 * value optimistically while the module saves it. The expand chevron and the drag handle live in a
 * different cell and are plain controls — clicking either never opens an editor.
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
    catalogs,
    editingCell = null,
    cellPatches,
    onStartCellEdit,
    onCancelCellEdit,
    onCommitCellEdit,
}: TaskRowProps) {
    const indentDepth = Math.min(node.depth, MAX_INDENT_DEPTH);
    const subtaskCount = node.children.length;
    const subtaskLabel = `${subtaskCount} sub-task${subtaskCount === 1 ? "" : "s"}`;
    const expandLabel = isExpanded ? `Collapse ${node.title}` : `Expand ${node.title}`;

    const patchFor = useCallback(
        (column: string): TaskRowPatch | undefined => cellPatches?.get(`${node.id}:${column}`),
        [cellPatches, node.id],
    );

    const title = patched(patchFor("title"), "title", node.title);
    const status = patched(patchFor("status"), "status", node.status);
    const priority = patched(patchFor("priority"), "priority", node.priority);
    const assignees = patched(patchFor("assignees"), "assignees", node.assignees);
    const startDate = patched(patchFor("start"), "start_date", node.start_date);
    const endDate = patched(patchFor("due"), "end_date", node.end_date);

    // An edit affordance only exists when the row is editable AND the module wired the handlers —
    // a read-only row (or one rendered from fixtures) stays exactly as it was before.
    const editable =
        node.can_edit &&
        onStartCellEdit !== undefined &&
        onCancelCellEdit !== undefined &&
        onCommitCellEdit !== undefined;

    const isCellEditing = useCallback(
        (column: string): boolean =>
            editable &&
            editingCell !== null &&
            editingCell.taskId === node.id &&
            editingCell.column === column,
        [editable, editingCell, node.id],
    );

    const startEdit = useCallback(
        (column: string): void => onStartCellEdit?.(node.id, column),
        [onStartCellEdit, node.id],
    );
    const cancelEdit = useCallback((): void => onCancelCellEdit?.(), [onCancelCellEdit]);
    const commitEdit = useCallback(
        (column: string, request: CellEditRequest): void =>
            onCommitCellEdit?.(node.id, column, request),
        [onCommitCellEdit, node.id],
    );

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
                    {editable && isCellEditing("title") ? (
                        <div className="min-w-0 flex-1">
                            <TaskCellEditor
                                spec={{ kind: "title", value: title }}
                                label="Task title"
                                taskTitle={title}
                                onCommit={(request) => commitEdit("title", request)}
                                onCancel={cancelEdit}
                            />
                        </div>
                    ) : editable ? (
                        <button
                            type="button"
                            aria-label={`Edit title for ${title}`}
                            title={`Edit title for ${title}`}
                            data-slot="task-cell-edit"
                            className={cn(CELL_BUTTON_CLASS, "min-w-0 font-medium")}
                            onClick={() => startEdit("title")}
                        >
                            <span className="block max-w-[320px] truncate">{title}</span>
                        </button>
                    ) : (
                        <span className="block max-w-[320px] truncate font-medium" title={title}>
                            {title}
                        </span>
                    )}
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

            {/*
             * The assignees cell is DISPLAY ONLY: it shows the compact avatar stack. Clicking it
             * requests the assignees edit, which the module answers with the centered assignees
             * dialog — never an inline picker in this 160px column (a wrapping chip field here is
             * exactly what made the row tall and clumped before).
             */}
            <TableCell className="max-w-[160px]">
                {editable ? (
                    <button
                        type="button"
                        aria-label={`Edit assignees for ${title}`}
                        title={`Edit assignees for ${title}`}
                        data-slot="task-cell-edit"
                        className={cn(CELL_BUTTON_CLASS, "cursor-pointer")}
                        onClick={() => startEdit("assignees")}
                    >
                        <AssigneeStack assignees={assignees} />
                    </button>
                ) : (
                    <AssigneeStack assignees={assignees} />
                )}
            </TableCell>

            <TableCell className="max-w-[160px]">
                {editable && isCellEditing("start") ? (
                    <TaskCellEditor
                        spec={{ kind: "date", field: "start", value: startDate }}
                        label="Start date"
                        taskTitle={title}
                        onCommit={(request) => commitEdit("start", request)}
                        onCancel={cancelEdit}
                    />
                ) : editable ? (
                    <button
                        type="button"
                        aria-label={`Edit start date for ${title}`}
                        title={`Edit start date for ${title}`}
                        data-slot="task-cell-edit"
                        className={CELL_BUTTON_CLASS}
                        onClick={() => startEdit("start")}
                    >
                        <span className="block truncate text-muted-foreground">
                            {formatTaskDate(startDate)}
                        </span>
                    </button>
                ) : (
                    <span
                        className="block truncate text-muted-foreground"
                        title={`Start: ${formatTaskDate(startDate)}`}
                    >
                        {formatTaskDate(startDate)}
                    </span>
                )}
            </TableCell>

            <TableCell className="max-w-[160px]">
                {editable && isCellEditing("due") ? (
                    <TaskCellEditor
                        spec={{ kind: "date", field: "end", value: endDate }}
                        label="Due date"
                        taskTitle={title}
                        onCommit={(request) => commitEdit("due", request)}
                        onCancel={cancelEdit}
                    />
                ) : editable ? (
                    <button
                        type="button"
                        aria-label={`Edit due date for ${title}`}
                        title={`Edit due date for ${title}`}
                        data-slot="task-cell-edit"
                        className={CELL_BUTTON_CLASS}
                        onClick={() => startEdit("due")}
                    >
                        <span className="block truncate text-muted-foreground">
                            {formatTaskDate(endDate)}
                        </span>
                    </button>
                ) : (
                    <span
                        className="block truncate text-muted-foreground"
                        title={`Due: ${formatTaskDate(endDate)}`}
                    >
                        {formatTaskDate(endDate)}
                    </span>
                )}
            </TableCell>

            <TableCell className="max-w-[140px]">
                {editable && isCellEditing("priority") ? (
                    <TaskCellEditor
                        spec={{
                            kind: "catalog",
                            target: "priority",
                            options: catalogs?.priorities ?? [],
                            value: node.priority_id,
                        }}
                        label="Priority"
                        taskTitle={title}
                        onCommit={(request) => commitEdit("priority", request)}
                        onCancel={cancelEdit}
                    />
                ) : editable ? (
                    <button
                        type="button"
                        aria-label={`Edit priority for ${title}`}
                        title={`Edit priority for ${title}`}
                        data-slot="task-cell-edit"
                        className={CELL_BUTTON_CLASS}
                        onClick={() => startEdit("priority")}
                    >
                        <TaskPriorityBadge priority={priority} />
                    </button>
                ) : (
                    <TaskPriorityBadge priority={priority} />
                )}
            </TableCell>

            <TableCell className="max-w-[140px]">
                {editable && isCellEditing("status") ? (
                    <TaskCellEditor
                        spec={{
                            kind: "catalog",
                            target: "status",
                            options: catalogs?.statuses ?? [],
                            value: node.status_id,
                        }}
                        label="Status"
                        taskTitle={title}
                        onCommit={(request) => commitEdit("status", request)}
                        onCancel={cancelEdit}
                    />
                ) : editable ? (
                    <button
                        type="button"
                        aria-label={`Edit status for ${title}`}
                        title={`Edit status for ${title}`}
                        data-slot="task-cell-edit"
                        className={CELL_BUTTON_CLASS}
                        onClick={() => startEdit("status")}
                    >
                        <TaskStatusBadge status={status} />
                    </button>
                ) : (
                    <TaskStatusBadge status={status} />
                )}
            </TableCell>

            {fields.map((field) => {
                const column = `field-${field.id}`;
                const answer =
                    patched(patchFor(column), "custom_values", node.custom_values).find(
                        (entry) => entry.field_id === field.id,
                    )?.value ?? null;
                const text = formatTaskFieldValue(field, answer);
                const isChoice = field.field_type === "select";

                return (
                    <TableCell key={field.id} className="max-w-[160px]">
                        {editable && isCellEditing(column) ? (
                            <TaskCellEditor
                                spec={{ kind: "field", field, value: answer }}
                                label={field.label}
                                taskTitle={title}
                                onCommit={(request) => commitEdit(column, request)}
                                onCancel={cancelEdit}
                            />
                        ) : editable ? (
                            <button
                                type="button"
                                aria-label={`Edit ${field.label} for ${title}`}
                                title={`Edit ${field.label} for ${title}`}
                                data-slot="task-cell-edit"
                                className={CELL_BUTTON_CLASS}
                                onClick={() => startEdit(column)}
                            >
                                {isChoice ? (
                                    <FieldChoiceChip field={field} value={answer} />
                                ) : (
                                    <span className="block truncate text-muted-foreground" title={text}>
                                        {text}
                                    </span>
                                )}
                            </button>
                        ) : isChoice ? (
                            <FieldChoiceChip field={field} value={answer} />
                        ) : (
                            <span className="block truncate text-muted-foreground" title={text}>
                                {text}
                            </span>
                        )}
                    </TableCell>
                );
            })}

            <TableCell className="w-[72px] text-right">
                {actions ?? <span className="sr-only">No actions available</span>}
            </TableCell>
        </TableRow>
    );
}

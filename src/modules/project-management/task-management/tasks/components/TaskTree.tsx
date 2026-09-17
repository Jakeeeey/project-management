"use client";

import { Fragment, useMemo, type ReactNode } from "react";
import { ChevronRight, ListTree, RotateCcw, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { flattenVisible, type TreeNode } from "@/modules/project-management/utils/tree";

import { AssigneeStack } from "./AssigneeStack";
import {
    INDENT_STEP_PX,
    MAX_INDENT_DEPTH,
    TaskRow,
    formatTaskDate,
    formatTaskFieldValue,
    type TaskRowPatch,
    type TaskRowProps,
    type TaskRowView,
} from "./TaskRow";
import { TaskPriorityBadge, TaskStatusBadge } from "./TaskRowBadges";
import type { CellEditRequest, CellMemberOption } from "./TaskCellEditor";
import type { TaskCatalogs, TaskField } from "../hooks/useTasks";

function subtaskLabel(count: number): string {
    return `${count} sub-task${count === 1 ? "" : "s"}`;
}

interface TaskTreeColumn {
    key: string;
    label: string;
    /** Column holds no visible title (a control or an actions gutter). */
    srOnly?: boolean;
    className?: string;
}

/**
 * The fixed columns, in order — the custom columns and the actions gutter are appended at render
 * time, so this is only the part that never varies.
 *
 * The widths are chosen so the columns' SUM stays under the `max-w-7xl` container's usable width at
 * `xl` and up. Start and due are two separate columns now, so the title, priority, status,
 * assignees and custom-column widths were trimmed to make room for the second date column.
 *
 * Order: the expand gutter, then task title, assignees, start, due, priority and status; the
 * custom columns follow the fixed set and the actions gutter is appended last.
 */
const BASE_COLUMNS: readonly TaskTreeColumn[] = [
    { key: "expand", label: "Expand", srOnly: true, className: "w-[76px]" },
    { key: "title", label: "Task", className: "min-w-[220px]" },
    { key: "assignees", label: "Assignees", className: "w-[160px]" },
    { key: "start", label: "Start", className: "w-[160px]" },
    { key: "due", label: "Due", className: "w-[160px]" },
    { key: "priority", label: "Priority", className: "w-[140px]" },
    { key: "status", label: "Status", className: "w-[140px]" },
];

/** The actions gutter is always last, whatever the department has added. */
const ACTIONS_COLUMN: TaskTreeColumn = {
    key: "actions",
    label: "Actions",
    srOnly: true,
    className: "w-[72px] text-right",
};

/** The rendered columns: the fixed set, then one per custom column, then the actions gutter. */
function buildColumns(fields: readonly TaskField[]): TaskTreeColumn[] {
    return [
        ...BASE_COLUMNS,
        ...fields.map((field) => ({
            key: `field-${field.id}`,
            label: field.label,
            className: "w-[160px]",
        })),
        ACTIONS_COLUMN,
    ];
}

interface SiblingPosition {
    posInSet: number;
    setSize: number;
}

/**
 * Maps every node to its 1-based position among its siblings and its level's size.
 *
 * Taken from the FULL tree, not from the visible projection: `aria-setsize` must not shrink when
 * a sibling is collapsed. Iterative breadth-first, so an arbitrarily deep tree cannot overflow the
 * call stack.
 */
function computeSiblingPositions(
    roots: readonly TreeNode<TaskRowView>[],
): Map<number, SiblingPosition> {
    const positions = new Map<number, SiblingPosition>();
    let frontier: TreeNode<TaskRowView>[][] = roots.length > 0 ? [[...roots]] : [];

    while (frontier.length > 0) {
        const next: TreeNode<TaskRowView>[][] = [];
        for (const siblings of frontier) {
            siblings.forEach((node, index) => {
                positions.set(node.id, { posInSet: index + 1, setSize: siblings.length });
                if (node.children.length > 0) next.push(node.children);
            });
        }
        frontier = next;
    }

    return positions;
}

export interface TaskTreeProps {
    /** The department's forest from `buildTree` — never a flattened list. */
    roots: readonly TreeNode<TaskRowView>[];
    /** Ids whose children are currently shown. */
    expandedIds: ReadonlySet<number>;
    onToggleExpand: (id: number) => void;
    isLoading?: boolean;
    /** A non-empty string renders the persistent error state (with `onRetry` when supplied). */
    error?: string | null;
    onRetry?: () => void;
    /** One short sentence for the empty state. */
    emptyMessage?: string;
    /** Slot for the dnd-kit handle cell content (todo 6). */
    renderDragHandle?: (node: TreeNode<TaskRowView>) => ReactNode;
    /** Slot for each row's actions menu. */
    renderActions?: (node: TreeNode<TaskRowView>) => ReactNode;
    /**
     * Overrides how a data row is rendered. Defaults to `TaskRow`. Todo 6 passes a wrapper that
     * renders `TaskRow` inside its sortable shell; the tree keeps owning the aria/computed props.
     */
    renderRow?: (props: TaskRowProps) => ReactNode;
    /** The department's custom columns — one extra table column and one extra card field each. */
    fields?: readonly TaskField[];
    /**
     * In-place editing seam. When `onStartCellEdit` is supplied the WIDE table's data cells become
     * editable; the narrow-viewport card below `xl` stays a read-only projection, because it has no
     * per-column cell to swap an editor into.
     */
    catalogs?: TaskCatalogs;
    members?: readonly CellMemberOption[];
    editingCell?: { readonly taskId: number; readonly column: string } | null;
    cellPatches?: ReadonlyMap<string, TaskRowPatch>;
    onStartCellEdit?: (taskId: number, column: string) => void;
    onCancelCellEdit?: () => void;
    onCommitCellEdit?: (taskId: number, column: string, request: CellEditRequest) => void;
    className?: string;
    /** Accessible name of the grid. */
    "aria-label"?: string;
}

interface StatePanelProps {
    icon: ReactNode;
    message: ReactNode;
    pulse?: boolean;
    onRetry?: () => void;
}

/** The narrow-viewport counterpart of a table state row (below `xl` there is no table to put it in). */
function StatePanel({ icon, message, pulse = false, onRetry }: StatePanelProps) {
    return (
        <div
            data-slot="task-tree-state-panel"
            className="flex h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
        >
            {icon}
            <p className={cn("text-sm text-muted-foreground", pulse && "animate-pulse")}>{message}</p>
            {onRetry && (
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Try again
                </Button>
            )}
        </div>
    );
}

/**
 * The task tree's table shell.
 *
 * A tree cannot be expressed by the generic shared data table — that table has no expand rows, no
 * indentation and no `aria-level` — so this composes the raw `Table` primitives directly. It owns
 * the header, the loading / empty / error states and the horizontal-scroll wrapper, and delegates
 * each data row to `TaskRow` (or the caller's `renderRow`).
 *
 * Wide viewports get the table; below `xl` the same rows render as a stacked card list carrying the
 * same fields and the same actions, because a 7-column grid is unusable on a phone. Loading, empty
 * and error states are shown on BOTH surfaces so the narrow view is never blank.
 *
 * Purely presentational: rows, expansion state and catalogs arrive as props, so it mounts with
 * fixtures and no API.
 */
export function TaskTree({
    roots,
    expandedIds,
    onToggleExpand,
    isLoading = false,
    error = null,
    onRetry,
    emptyMessage = "No tasks found.",
    renderDragHandle,
    renderActions,
    renderRow,
    fields = [],
    catalogs,
    members,
    editingCell = null,
    cellPatches,
    onStartCellEdit,
    onCancelCellEdit,
    onCommitCellEdit,
    className,
    "aria-label": ariaLabel = "Task list",
}: TaskTreeProps) {
    const visible = useMemo(() => flattenVisible(roots, expandedIds), [roots, expandedIds]);
    const positions = useMemo(() => computeSiblingPositions(roots), [roots]);
    const columns = useMemo(() => buildColumns(fields), [fields]);

    const showError = error !== null && error !== "";
    const isEmpty = !isLoading && !showError && visible.length === 0;
    const columnCount = columns.length;

    const loadingRow = (
        <TableRow data-slot="task-tree-loading">
            <TableCell colSpan={columnCount} className="h-48 text-center">
                <div className="flex flex-col items-center justify-center gap-3">
                    <Spinner className="size-6 text-muted-foreground" />
                    <p className="animate-pulse text-sm text-muted-foreground">Loading tasks…</p>
                </div>
            </TableCell>
        </TableRow>
    );

    const emptyRow = (
        <TableRow data-slot="task-tree-empty">
            <TableCell colSpan={columnCount} className="h-48 text-center">
                <div className="flex flex-col items-center justify-center gap-2">
                    <ListTree className="size-8 text-muted-foreground/50" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">{emptyMessage}</p>
                </div>
            </TableCell>
        </TableRow>
    );

    const errorRow = (
        <TableRow data-slot="task-tree-error">
            <TableCell colSpan={columnCount} className="h-48 text-center">
                <div className="flex flex-col items-center justify-center gap-3" role="alert">
                    <TriangleAlert className="size-8 text-destructive" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">{error}</p>
                    {onRetry && (
                        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                            <RotateCcw className="size-4" aria-hidden="true" />
                            Try again
                        </Button>
                    )}
                </div>
            </TableCell>
        </TableRow>
    );

    return (
        <div data-slot="task-tree" className={cn("space-y-3", className)}>
            <div className="xl:hidden">
                {isLoading ? (
                    <StatePanel
                        icon={<Spinner className="size-6 text-muted-foreground" />}
                        message="Loading tasks…"
                        pulse
                    />
                ) : showError ? (
                    <StatePanel
                        icon={<TriangleAlert className="size-8 text-destructive" aria-hidden="true" />}
                        message={error}
                        onRetry={onRetry}
                    />
                ) : isEmpty ? (
                    <StatePanel
                        icon={<ListTree className="size-8 text-muted-foreground/50" aria-hidden="true" />}
                        message={emptyMessage}
                    />
                ) : (
                    <ul
                        data-slot="task-tree-cards"
                        className="divide-y divide-border rounded-2xl border border-border/50 bg-card shadow-sm"
                    >
                        {visible.map((node) => {
                            const position = positions.get(node.id) ?? { posInSet: 1, setSize: 1 };
                            const hasChildren = node.children.length > 0;
                            const isExpanded = expandedIds.has(node.id);
                            const indentDepth = Math.min(node.depth, MAX_INDENT_DEPTH);
                            const expandLabel = isExpanded ? `Collapse ${node.title}` : `Expand ${node.title}`;
                            const startText = formatTaskDate(node.start_date);
                            const endText = formatTaskDate(node.end_date);

                            return (
                                <li
                                    key={node.id}
                                    data-slot="task-tree-card"
                                    data-task-id={node.id}
                                    data-depth={node.depth}
                                    data-indent-depth={indentDepth}
                                    aria-level={node.depth + 1}
                                    aria-posinset={position.posInSet}
                                    aria-setsize={position.setSize}
                                    className="p-3"
                                >
                                    <div
                                        className="flex items-start gap-2"
                                        style={{ paddingLeft: indentDepth * INDENT_STEP_PX }}
                                    >
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
                                                className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                                            >
                                                <ChevronRight
                                                    className={cn(
                                                        "size-3.5 transition-transform",
                                                        isExpanded && "rotate-90",
                                                    )}
                                                    aria-hidden="true"
                                                />
                                            </Button>
                                        ) : null}

                                        <div className="min-w-0 flex-1 space-y-1.5">
                                            <div className="flex items-center gap-1.5">
                                                <p
                                                    className="min-w-0 break-words text-sm font-medium"
                                                    title={node.title}
                                                >
                                                    {node.title}
                                                </p>
                                                {hasChildren ? (
                                                    <Badge
                                                        variant="secondary"
                                                        data-slot="task-subtask-count"
                                                        title={subtaskLabel(node.children.length)}
                                                        className="shrink-0 border-border/60 px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground"
                                                    >
                                                        <span aria-hidden="true">{node.children.length}</span>
                                                        <span className="sr-only">
                                                            {subtaskLabel(node.children.length)}
                                                        </span>
                                                    </Badge>
                                                ) : null}
                                            </div>
                                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                                <AssigneeStack assignees={node.assignees} max={2} />
                                                <span title={`Start: ${startText}`}>Start: {startText}</span>
                                                <span title={`Due: ${endText}`}>Due: {endText}</span>
                                            </div>
                                            <div
                                                data-slot="task-row-badges"
                                                className="flex flex-wrap items-center gap-1.5"
                                            >
                                                <TaskPriorityBadge priority={node.priority} />
                                                <TaskStatusBadge status={node.status} />
                                            </div>
                                            {fields.length > 0 ? (
                                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                                    {fields.map((field) => {
                                                        const answer =
                                                            node.custom_values.find(
                                                                (entry) => entry.field_id === field.id,
                                                            )?.value ?? null;
                                                        return (
                                                            <span key={field.id} className="inline-flex items-center gap-1">
                                                                <span className="font-medium">{field.label}:</span>
                                                                <span>{formatTaskFieldValue(field, answer)}</span>
                                                            </span>
                                                        );
                                                    })}
                                                </div>
                                            ) : null}
                                        </div>

                                        {renderActions?.(node)}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <div className="hidden overflow-x-auto xl:block">
                <div className="rounded-2xl border border-border/50 bg-card shadow-sm">
                    <Table role="treegrid" aria-label={ariaLabel} className="min-w-[1120px]">
                        <TableHeader className="bg-muted/30">
                            <TableRow>
                                {columns.map((column) => (
                                    <TableHead key={column.key} scope="col" className={cn(column.className)}>
                                        {column.srOnly ? <span className="sr-only">{column.label}</span> : column.label}
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? loadingRow
                                : showError
                                  ? errorRow
                                  : isEmpty
                                    ? emptyRow
                                    : visible.map((node) => {
                                          const position = positions.get(node.id) ?? { posInSet: 1, setSize: 1 };
                                          const hasChildren = node.children.length > 0;
                                          const rowProps: TaskRowProps = {
                                              node,
                                              posInSet: position.posInSet,
                                              setSize: position.setSize,
                                              hasChildren,
                                              isExpanded: expandedIds.has(node.id),
                                              onToggleExpand,
                                              dragHandle: renderDragHandle?.(node),
                                              actions: renderActions?.(node),
                                              fields,
                                              catalogs,
                                              members,
                                              editingCell,
                                              cellPatches,
                                              onStartCellEdit,
                                              onCancelCellEdit,
                                              onCommitCellEdit,
                                          };
                                          const rendered = renderRow
                                              ? renderRow(rowProps)
                                              : <TaskRow {...rowProps} />;
                                          return <Fragment key={node.id}>{rendered}</Fragment>;
                                      })}
                        </TableBody>
                    </Table>
                </div>
            </div>
        </div>
    );
}

"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type KeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, ListTree, RotateCcw, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import type { TaskField, TaskListItem } from "../../hooks/useTasks";
import type { TaskViewProps } from "../../types/task-view";
import {
    columnChoiceScore,
    completionFlag,
    computeCompletion,
    describeCompletionPercent,
    formatCompletionPercent,
    statusCompletionScore,
    type CompletionFlag,
    type CompletionRollup,
} from "../../utils/completion";
import { buildTree, flattenVisible, type TreeSourceRow, type TreeNode } from "../../utils/tree";
import { MultiSelectCombobox, type MultiSelectComboboxOption } from "../MultiSelectCombobox";
import { NO_STATUS_LABEL, TaskStatusBadge } from "../TaskRowBadges";
import { TaskCombobox, type TaskComboboxOption } from "../TaskCombobox";

/**
 * The Progress view: the department's tasks as a read-only completion tree-table.
 *
 * Every number here comes from {@link computeCompletion} — the one rollup — never from a local
 * average, so the two bases (a task's own status percentage, or whether it carries a chosen answer
 * in one Choice column) can only differ in what a LEAF scores, never in how a parent is averaged.
 *
 * The view owns three pieces of UI state and nothing else: which basis is showing, which siblings
 * sort order is showing, and which parents are collapsed. It never fetches and never writes, so the
 * shell stays the only owner of the rows and of retries.
 *
 * Only a window of rows is mounted ({@link useVirtualizer}). That is what makes the tab survive a
 * fully expanded tree: the DOM holds what is on screen, not what the list contains.
 */

type ProgressMode = "status" | "column";
type ProgressSort = "tree" | "lowest";

const MODE_LABELS: Record<ProgressMode, string> = {
    status: "By status",
    column: "By column",
};

const SORT_LABELS: Record<ProgressSort, string> = {
    tree: "Tree order",
    lowest: "Lowest first",
};

/**
 * The visual indent step and its cap. The cap is PRESENTATION ONLY — `aria-level` always carries the
 * row's true depth, so a deep branch reads correctly to a screen reader while the table stays narrow.
 */
const INDENT_STEP_PX = 12;
const MAX_INDENT_DEPTH = 6;

/** 80px on the number's left, so every row's bar lines up regardless of the digits beside it. */
const BAR_CLASS = "h-2 w-20 shrink-0";

/**
 * Geometry. A row is two lines when its parent carries the "N subtasks" count, or when the view is
 * grouped by a column and a leaf has to name the answer it scored from; otherwise it is one line.
 * Both numbers are MEASURED back from the DOM through `measureElement`, so they seed the offsets and
 * never accumulate a guess.
 *
 * Column widths come from a `<colgroup>`, so a recycled row can never reflow a column. And the row
 * hairline is an INSET SHADOW rather than a border, because a border adds to the measured box and
 * every row below it would drift.
 */
const PARENT_ROW_HEIGHT_PX = 56;
const LEAF_ROW_HEIGHT_PX = 40;
const CARD_HEIGHT_PX = 72;
const OVERSCAN_ROWS = 10;
const STATUS_COLUMN_PX = 160;
const COMPLETE_COLUMN_PX = 144;
const NOTE_COLUMN_PX = 256;
/** Below `xl` the Note cell holds the flag icon alone, so the column shrinks to the icon. */
const NOTE_COMPACT_COLUMN_PX = 40;
/** 40px of sticky header, 4px of air: a row scrolled to this offset is never hidden behind it. */
const HEADER_SCROLL_PADDING_PX = 44;

/**
 * A body row's shared chrome. Nothing here pins a height: the row box is whatever its cells measure,
 * and the virtualizer is told that number by `measureElement`.
 */
const ROW_CLASS = cn(
    "border-b-0 transition-colors",
    "[&>th]:shadow-[inset_0_-1px_0_var(--color-border)]",
    "[&>td]:shadow-[inset_0_-1px_0_var(--color-border)]",
    "focus-visible:bg-accent focus-visible:outline-none",
    "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
);

/** The scroll box is the row window's viewport, in both layouts. */
const SCROLL_BOX_CLASS = cn(
    "max-h-[calc(100dvh_-_16rem)] overflow-auto overscroll-contain outline-none",
    "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
);

const FLAG_COPY: Record<CompletionFlag, string> = {
    "complete-with-unfinished-subtasks": "Marked complete, subtasks unfinished",
    "subtasks-complete-not-marked": "All subtasks complete, not marked complete",
};

const EMPTY_VALUES: ReadonlyMap<number, number> = new Map<number, number>();
const NO_VALUE: CompletionRollup = {
    valueById: EMPTY_VALUES,
    ownById: EMPTY_VALUES,
    childCountById: EMPTY_VALUES,
};

function subtaskCountLabel(count: number): string {
    return `${count} subtask${count === 1 ? "" : "s"}`;
}

/** A leaf's second line under "By column" when the task carries no answer for that column. */
const NO_ANSWER_LABEL = "No answer";

function taskTitle(task: TaskListItem): string {
    return task.title.trim() === "" ? "Untitled task" : task.title;
}

/**
 * Reorders SIBLINGS by their rolled-up value, recursing into each level.
 *
 * The forest is untouched structurally: a child never moves out from under its parent, so "lowest
 * first" cannot flatten the tree or re-parent a row. `buildTree` already sorted every level by
 * `(sort_order, id)`; `Array.prototype.sort` is stable, so equal values keep that original order.
 */
function sortSiblingsByValue<T extends TreeSourceRow>(
    nodes: TreeNode<T>[],
    valueById: ReadonlyMap<number, number>,
): void {
    nodes.sort((a, b) => (valueById.get(a.id) ?? 0) - (valueById.get(b.id) ?? 0));
    for (const node of nodes) sortSiblingsByValue(node.children, valueById);
}

/** The per-row facts the table renders, resolved once per render for one visible node. */
interface ProgressNode {
    readonly node: TreeNode<TaskListItem>;
    readonly value: number;
    readonly own: number;
    readonly childCount: number;
    readonly flag: CompletionFlag | null;
}

/**
 * A media query as state, for the two things CSS alone cannot do here: the card and table layouts
 * measure different row heights, and the virtualizer needs the one that is actually mounted.
 *
 * The first paint takes the wide branch — the table — so the server and the client agree; a narrow
 * viewport swaps one frame after hydration.
 */
function useMediaQuery(query: string): boolean {
    const subscribe = useCallback(
        (onStoreChange: () => void) => {
            const list = window.matchMedia(query);
            list.addEventListener("change", onStoreChange);
            return () => list.removeEventListener("change", onStoreChange);
        },
        [query],
    );

    return useSyncExternalStore(
        subscribe,
        () => window.matchMedia(query).matches,
        () => false,
    );
}

interface RowChevronProps {
    title: string;
    expanded: boolean;
    onToggle: () => void;
}

/**
 * A parent's expand control: a real 24px button, so it is not a pixel hunt, and its click stops
 * there — the row's own click opens the task, and expanding must never open the detail sheet.
 *
 * It is kept out of the tab order on purpose: the grid has one tab stop, the row, and ArrowRight /
 * ArrowLeft expand and collapse from there. Enter and Space on the row activate the task.
 */
function RowChevron({ title, expanded, onToggle }: RowChevronProps) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
            title={expanded ? "Collapse" : "Expand"}
            onClick={(event) => {
                event.stopPropagation();
                onToggle();
            }}
        >
            <ChevronRight
                className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                aria-hidden="true"
            />
        </Button>
    );
}

/**
 * The subtask count, in the fixed slot that keeps every title on the same left edge.
 *
 * The slot is always rendered, empty for a leaf, so a recycled row cannot shift the column. The
 * number is decorative for a screen reader: the count is already inside the row's completion
 * sentence ("average of 4 subtasks"), and repeating it here would announce it twice.
 */
function RowCount({ count }: { count: number }) {
    return (
        <span className="flex w-6 shrink-0 items-center justify-center">
            {count > 0 ? (
                <Badge
                    variant="secondary"
                    title={subtaskCountLabel(count)}
                    className="shrink-0 border-border/60 px-1 text-[10px] font-semibold tabular-nums text-muted-foreground"
                >
                    <span aria-hidden="true">{count}</span>
                    <span className="sr-only">{subtaskCountLabel(count)}</span>
                </Badge>
            ) : null}
        </span>
    );
}

export function ProgressView({
    items,
    catalogs,
    fields,
    isLoading,
    error,
    onRetry,
    onOpenTask,
}: TaskViewProps) {
    const [mode, setMode] = useState<ProgressMode>("status");
    /** The chosen Choice column's id as a string, because both comboboxes key by string. */
    const [columnValue, setColumnValue] = useState<string | null>(null);
    const [doneValues, setDoneValues] = useState<string[]>([]);
    const [sort, setSort] = useState<ProgressSort>("tree");
    /** COLLAPSED ids, so the first paint is fully expanded without seeding a set from the rows. */
    const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<number>>(() => new Set<number>());

    /** Status id -> the department's stored completion percentage; an absent status scores 0. */
    const percentByStatusId = useMemo(() => {
        const percents = new Map<number, number>();
        for (const status of catalogs.statuses) {
            percents.set(status.id, status.completion_percent);
        }
        return percents;
    }, [catalogs.statuses]);

    /** Only `select` columns are Directus Choice columns, and only they carry pickable options. */
    const choiceFields = useMemo<TaskField[]>(
        () => fields.filter((field) => field.field_type === "select"),
        [fields],
    );

    const chosenField = useMemo(
        () => choiceFields.find((field) => String(field.id) === columnValue) ?? null,
        [choiceFields, columnValue],
    );

    const doneSet = useMemo(() => new Set(doneValues), [doneValues]);

    /**
     * Nothing computes in column mode until a column AND at least one done answer are chosen: an
     * empty done set would print an honest but meaningless all-zero table.
     */
    const ready = mode === "status" || (chosenField !== null && doneSet.size > 0);

    const rollup = useMemo<CompletionRollup>(() => {
        if (!ready) return NO_VALUE;
        if (mode === "status") {
            return computeCompletion(items, statusCompletionScore(percentByStatusId));
        }
        if (chosenField === null) return NO_VALUE;
        return computeCompletion(items, columnChoiceScore<TaskListItem>(chosenField.id, doneSet));
    }, [items, ready, mode, chosenField, doneSet, percentByStatusId]);

    const forest = useMemo(() => {
        const roots = buildTree(items);
        if (sort === "lowest") sortSiblingsByValue(roots, rollup.valueById);
        return roots;
    }, [items, sort, rollup]);

    /** Every id that has children — the only ids `flattenVisible` cares about. */
    const parentIds = useMemo(() => {
        const ids = new Set<number>();
        const stack: TreeNode<TaskListItem>[] = [...forest];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === undefined) continue;
            if (node.children.length === 0) continue;
            ids.add(node.id);
            for (const child of node.children) stack.push(child);
        }
        return ids;
    }, [forest]);

    const expandedIds = useMemo(() => {
        const ids = new Set<number>();
        for (const id of parentIds) if (!collapsedIds.has(id)) ids.add(id);
        return ids;
    }, [parentIds, collapsedIds]);

    const visible = useMemo(() => flattenVisible(forest, expandedIds), [forest, expandedIds]);

    const rows = useMemo<ProgressNode[]>(
        () =>
            visible.map((node) => {
                const value = rollup.valueById.get(node.id) ?? 0;
                const own = rollup.ownById.get(node.id) ?? 0;
                const childCount = rollup.childCountById.get(node.id) ?? 0;
                return { node, value, own, childCount, flag: completionFlag(own, value, childCount) };
            }),
        [visible, rollup],
    );

    /**
     * Each row's index in the FLATTENED list, not in the rendered window. `aria-rowindex` is a
     * statement about the whole grid, so it has to be the absolute one; the keyboard walks the same
     * numbers to know what "the next row" means.
     */
    const indexById = useMemo(() => {
        const positions = new Map<number, number>();
        rows.forEach((row, index) => positions.set(row.node.id, index));
        return positions;
    }, [rows]);

    const isCardLayout = useMediaQuery("(max-width: 767px)");
    const isWideLayout = useMediaQuery("(min-width: 1280px)");

    const scrollRef = useRef<HTMLDivElement | null>(null);
    /** The row the grid's keyboard is on. Null until the grid is focused. */
    const [activeId, setActiveId] = useState<number | null>(null);

    /**
     * The grid's single tab stop. It cannot simply be "the focused row": a row that scrolls out of
     * the window unmounts, so the stop has to survive that and fall back to the first row.
     */
    const rovingId = useMemo<number | null>(() => {
        if (rows.length === 0) return null;
        if (activeId !== null && indexById.has(activeId)) return activeId;
        return rows[0]?.node.id ?? null;
    }, [rows, activeId, indexById]);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        // A card is one fixed box; a table row is not — two lines whenever a parent shows its count
        // or a column-scored leaf names its answer. This is the seed only: every mounted row reports
        // its measured height back through `virtualizer.measureElement`.
        estimateSize: (index) => {
            if (isCardLayout) return CARD_HEIGHT_PX;
            const row = rows[index];
            const hasChildren = row !== undefined && row.childCount > 0;
            return hasChildren || mode === "column"
                ? PARENT_ROW_HEIGHT_PX
                : LEAF_ROW_HEIGHT_PX;
        },
        overscan: OVERSCAN_ROWS,
        // A row scrolled to the top edge of the box would sit behind the sticky header.
        scrollPaddingStart: HEADER_SCROLL_PADDING_PX,
    });

    // Row heights are measured, so both a layout switch and a list change invalidate what is cached:
    // rows keep their DOM node across a collapse while their index moves, and `measureElement` only
    // fires when a node mounts.
    useEffect(() => {
        virtualizer.measure();
    }, [virtualizer, rows, isCardLayout, mode]);

    // Heights change with the mode — a leaf gains a second line in `column` — so an offset carried
    // across would point at a different row.
    useEffect(() => {
        const box = scrollRef.current;
        if (box !== null) box.scrollTop = 0;
        virtualizer.scrollToOffset(0);
    }, [mode, virtualizer]);

    const toggleCollapsed = useCallback((id: number) => {
        setCollapsedIds((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    /**
     * Focus moves by id, not by element: the row the keyboard asked for is usually not mounted yet
     * when the handler runs. `scrollToIndex` makes the virtualizer mount it on the next frame, so
     * this retries for a few frames and then stops rather than fighting the user for focus.
     */
    const focusRowAt = useCallback(
        (index: number) => {
            const clamped = Math.min(Math.max(index, 0), rows.length - 1);
            const target = rows[clamped];
            if (target === undefined) return;
            const id = target.node.id;
            setActiveId(id);
            virtualizer.scrollToIndex(clamped, { align: "auto" });

            let attempts = 0;
            const focusWhenMounted = () => {
                const element = scrollRef.current?.querySelector<HTMLElement>(
                    `[data-row-id="${id}"]`,
                );
                if (element !== null && element !== undefined) {
                    element.focus({ preventScroll: true });
                    return;
                }
                attempts += 1;
                if (attempts < 8) requestAnimationFrame(focusWhenMounted);
            };
            requestAnimationFrame(focusWhenMounted);
        },
        [rows, virtualizer],
    );

    /**
     * `role="treegrid"` promises tree keyboard behavior, so it has to be here: Up/Down between rows,
     * Left collapses or steps to the parent, Right expands or steps into the first child, Home/End to
     * the ends. Everything moves by absolute index, which is also what scrolls a not-yet-mounted row
     * into the window.
     *
     * Enter and Space are NOT here on purpose: activation opens the task (the row handles it), the
     * same as every other view, and expansion stays on the arrows.
     */
    const handleGridKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>) => {
            const currentIndex = rovingId === null ? -1 : (indexById.get(rovingId) ?? -1);
            const current = rows[currentIndex];
            if (current === undefined) return;

            const key = event.key;
            const hasChildren = current.childCount > 0;
            const isExpanded = hasChildren && !collapsedIds.has(current.node.id);
            const parentId = current.node.parent_id;

            switch (key) {
                case "ArrowDown":
                    event.preventDefault();
                    focusRowAt(currentIndex + 1);
                    return;
                case "ArrowUp":
                    event.preventDefault();
                    focusRowAt(currentIndex - 1);
                    return;
                case "Home":
                    event.preventDefault();
                    focusRowAt(0);
                    return;
                case "End":
                    event.preventDefault();
                    focusRowAt(rows.length - 1);
                    return;
                case "ArrowRight":
                    if (!hasChildren) return;
                    event.preventDefault();
                    // Closed parent: Right opens it. Open parent: Right steps into its first child.
                    if (isExpanded) focusRowAt(currentIndex + 1);
                    else toggleCollapsed(current.node.id);
                    return;
                case "ArrowLeft": {
                    if (hasChildren && isExpanded) {
                        event.preventDefault();
                        toggleCollapsed(current.node.id);
                        return;
                    }
                    const parentIndex = parentId === null ? undefined : indexById.get(parentId);
                    if (parentIndex === undefined) return;
                    event.preventDefault();
                    focusRowAt(parentIndex);
                    return;
                }
                default:
                    return;
            }
        },
        [rows, indexById, rovingId, collapsedIds, toggleCollapsed, focusRowAt],
    );

    /**
     * The wheel scrolls content, not focus. A row that keeps DOM focus while it is scrolled out of
     * the window unmounts under the focus, so the box itself takes it — and only when something
     * inside the box had it, so a wheel flick over an unfocused page does not move the tab stop.
     */
    const handleScrollBoxWheel = useCallback(() => {
        const box = scrollRef.current;
        if (box === null) return;
        const active = document.activeElement;
        if (active === null || active === box || !box.contains(active)) return;
        box.focus({ preventScroll: true });
    }, []);

    /**
     * A row this wide invites a click anywhere on it, so a parent toggles from anywhere. The chevron
     * stays its own control: a click that started inside an interactive child is left to that child.
     * A leaf has nothing to expand and stays inert.
     *
     * Deliberately not a `<button>` around the row — the row is a `treegrid` row whose `aria-expanded`
     * already states the state, and nesting a button inside a button would break both.
     */
    /**
     * A click anywhere on a task opens it, matching the List, Board, Team, Calendar and Gantt views.
     * The chevron is the one exception and stops its own click: it expands, it never opens.
     *
     * The row is not wrapped in a button — it is a `treegrid` row, and its `aria-expanded` already
     * states the expansion. Activation is Enter/Space, and arrows stay on expansion.
     */
    const activateOnKeyDown = useCallback(
        (event: KeyboardEvent<HTMLElement>, id: number) => {
            if (onOpenTask === undefined) return;
            // A key that came from the chevron belongs to the chevron, not to the row.
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onOpenTask(id);
        },
        [onOpenTask],
    );

    const columnOptions = useMemo<TaskComboboxOption[]>(
        () => choiceFields.map((field) => ({ value: String(field.id), label: field.label })),
        [choiceFields],
    );

    const choiceOptions = useMemo<MultiSelectComboboxOption[]>(
        () =>
            (chosenField?.options ?? []).map((option) => ({
                value: String(option.id),
                label: option.label,
                color: option.color,
                icon: option.icon,
            })),
        [chosenField],
    );

    /**
     * Under "By column" a leaf is scored from its answer to that column, so its second line names
     * the answer it scored from — the same value `columnChoiceScore` reads.
     */
    const answerLabelById = useMemo(() => {
        const labels = new Map<string, string>();
        for (const option of chosenField?.options ?? []) {
            labels.set(String(option.id), option.label);
        }
        return labels;
    }, [chosenField]);

    const handleColumnChange = useCallback((next: string | null) => {
        setColumnValue(next);
        // Answers belong to the column they came from, so a new column always starts with none.
        setDoneValues([]);
    }, []);

    /**
     * Does any row carry one of the chosen answers? When none does, the column basis has nothing to
     * score and the view says so instead of rendering a table of zeros.
     */
    const carriesChosenAnswer = useMemo(() => {
        if (chosenField === null || doneSet.size === 0) return false;
        return items.some((task) =>
            task.custom_values.some(
                (answer) =>
                    answer.field_id === chosenField.id &&
                    answer.value !== null &&
                    doneSet.has(answer.value),
            ),
        );
    }, [items, chosenField, doneSet]);

    const statusPercentsUnset = useMemo(
        () => catalogs.statuses.every((status) => status.completion_percent === 0),
        [catalogs.statuses],
    );

    if (isLoading) return <ProgressSkeleton />;

    if (error !== null && error !== "") {
        return (
            <div
                data-slot="task-progress-error"
                role="alert"
                className="flex h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
            >
                <TriangleAlert className="size-8 text-destructive" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">Couldn&apos;t load this list.</p>
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Retry
                </Button>
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div
                data-slot="task-progress-empty"
                className="flex h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
            >
                <ListTree className="size-8 text-muted-foreground/50" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">No tasks in this list yet.</p>
                <p className="text-xs text-muted-foreground">
                    Add tasks in the List view to see completion here.
                </p>
            </div>
        );
    }

    const hiddenCount = items.length - rows.length;
    const showTable = ready && (mode === "status" || carriesChosenAnswer);
    /**
     * Under "By status" the status IS the basis, so its column would repeat the bar's sentence; the
     * table drops it and the spacer rows' `colSpan` has to follow the real count, or every cell after
     * the phantom column shifts one place right.
     */
    const showStatusColumn = mode === "column";
    const columnCount = showStatusColumn ? 4 : 3;
    /** Chosen and scored, but this list has no row carrying one of the answers — say so, don't print zeros. */
    const noChosenAnswers =
        !showTable && mode === "column" && chosenField !== null && doneSet.size > 0;

    /**
     * The window. `first.start` is the height of everything above it in the flattened list and
     * `totalSize - last.end` is the height of everything below, so two spacers reproduce the real
     * scroll height without mounting a row: offsets stay arithmetic, never a transform.
     */
    const virtualItems = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const firstItem = virtualItems[0];
    const lastItem = virtualItems[virtualItems.length - 1];
    const topSpacer = firstItem === undefined ? 0 : firstItem.start;
    const bottomSpacer =
        lastItem === undefined ? 0 : Math.max(0, totalSize - lastItem.end);

    return (
        <div data-slot="task-progress" className="w-full min-w-0 space-y-3">
            <div
                data-slot="task-progress-toolbar"
                className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
            >
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        value={mode}
                        onValueChange={(next) => setMode(next as ProgressMode)}
                    >
                        <SelectTrigger size="sm" className="w-36" aria-label="Completion basis">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="status">{MODE_LABELS.status}</SelectItem>
                            <SelectItem value="column">{MODE_LABELS.column}</SelectItem>
                        </SelectContent>
                    </Select>

                    {mode === "column" && choiceFields.length > 0 ? (
                        <>
                            <TaskCombobox
                                options={columnOptions}
                                value={columnValue}
                                onValueChange={handleColumnChange}
                                placeholder="Choose a column"
                                ariaLabel="Choice column"
                                showStatusIcon={false}
                                clearable={false}
                                className="w-56"
                            />
                            <MultiSelectCombobox
                                options={choiceOptions}
                                values={doneValues}
                                onValuesChange={setDoneValues}
                                placeholder="Counts as done"
                                ariaLabel="Counts as done"
                                emptyMessage="No choices in this column."
                                disabled={chosenField === null}
                                className="w-56"
                            />
                        </>
                    ) : null}
                </div>

                <Select value={sort} onValueChange={(next) => setSort(next as ProgressSort)}>
                    <SelectTrigger size="sm" className="w-40" aria-label="Sort tasks">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="tree">{SORT_LABELS.tree}</SelectItem>
                        <SelectItem value="lowest">{SORT_LABELS.lowest}</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {mode === "status" && statusPercentsUnset ? (
                <div
                    data-slot="task-progress-unset"
                    className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
                >
                    <TriangleAlert className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden="true" />
                    <span>
                        Status percentages haven&apos;t been set, so every task shows 0%. They&apos;re
                        set in the department&apos;s status settings.
                    </span>
                </div>
            ) : null}

            {mode === "column" && choiceFields.length === 0 ? (
                <p
                    data-slot="task-progress-no-choice-columns"
                    className="rounded-xl border border-border/50 bg-card px-3 py-6 text-center text-sm text-muted-foreground"
                >
                    This department has no Choice columns.
                </p>
            ) : null}

            {mode === "column" && chosenField !== null && !chosenField.is_enabled ? (
                <p data-slot="task-progress-hidden-column" className="text-xs text-muted-foreground">
                    This column is hidden from the task list. Showing the answers already saved.
                </p>
            ) : null}

            {mode === "column" && choiceFields.length > 0 && chosenField === null ? (
                <p data-slot="task-progress-no-column" className="text-xs text-muted-foreground">
                    Nothing computes until a column is chosen.
                </p>
            ) : null}

            {mode === "column" && chosenField !== null && doneSet.size === 0 ? (
                <p data-slot="task-progress-no-choices" className="text-xs text-muted-foreground">
                    Pick at least one choice to count as done.
                </p>
            ) : null}

            {showTable ? (
                <>
                    <p data-slot="task-progress-caption" className="text-xs text-muted-foreground">
                        {mode === "status"
                            ? "A task with subtasks averages its children, rounding down. A task without subtasks shows its own status's percentage."
                            : `A task counts as done when it carries a chosen answer in "${chosenField?.label ?? ""}"; the same average applies to parents.`}
                    </p>

                    <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
                        <div
                            ref={scrollRef}
                            role="group"
                            tabIndex={0}
                            aria-label="Task completion"
                            onKeyDown={handleGridKeyDown}
                            onWheel={handleScrollBoxWheel}
                            className={cn(
                                SCROLL_BOX_CLASS,
                                // `Table` ships its own `overflow-x-auto` box, which would trap
                                // `position: sticky` on the header. The scroll box is this one.
                                !isCardLayout && "[&>div]:overflow-visible",
                            )}
                        >
                            {isCardLayout ? (
                                <div role="tree" aria-label="Task completion">
                                    <div aria-hidden="true" style={{ height: topSpacer }} />
                                    {virtualItems.map((item) => {
                                        const row = rows[item.index];
                                        if (row === undefined) return null;
                                        const { node, value, childCount, flag } = row;
                                        const hasChildren = childCount > 0;
                                        const isExpanded =
                                            hasChildren && !collapsedIds.has(node.id);
                                        const title = taskTitle(node);
                                        const statusLabel =
                                            node.status?.label ?? NO_STATUS_LABEL;
                                        const indentDepth = Math.min(
                                            node.depth,
                                            MAX_INDENT_DEPTH,
                                        );
                                        const clippedDepth = node.depth - indentDepth;
                                        const complete = value >= 100;
                                        const muted = value <= 0;
                                        const basis = hasChildren
                                            ? `average of ${subtaskCountLabel(childCount)}`
                                            : mode === "status"
                                              ? `status ${statusLabel}`
                                              : `chosen answer in ${chosenField?.label ?? ""}`;
                                        const flagCopy =
                                            flag === null ? null : FLAG_COPY[flag];

                                        return (
                                            <div
                                                key={node.id}
                                                ref={virtualizer.measureElement}
                                                data-index={item.index}
                                                role="treeitem"
                                                data-slot="task-progress-card"
                                                data-row-id={node.id}
                                                aria-level={node.depth + 1}
                                                aria-expanded={
                                                    hasChildren ? isExpanded : undefined
                                                }
                                                // A tree item must be selectable-or-not; nothing
                                                // here is selectable, so this is always false.
                                                aria-selected={false}
                                                tabIndex={node.id === rovingId ? 0 : -1}
                                                onFocus={() => setActiveId(node.id)}
                                                onClick={
                                                    onOpenTask === undefined
                                                        ? undefined
                                                        : () => onOpenTask(node.id)
                                                }
                                                onKeyDown={(event) =>
                                                    activateOnKeyDown(event, node.id)
                                                }
                                                className={cn(
                                                    "flex h-[4.5rem] min-w-0 flex-col justify-center gap-1 px-2",
                                                    "border-b border-border/40 outline-none",
                                                    "focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
                                                    onOpenTask !== undefined && "cursor-pointer",
                                                )}
                                            >
                                                <div
                                                    className="flex min-w-0 items-center gap-1"
                                                    style={{
                                                        paddingLeft:
                                                            indentDepth * INDENT_STEP_PX,
                                                    }}
                                                >
                                                    {hasChildren ? (
                                                        <RowChevron
                                                            title={title}
                                                            expanded={isExpanded}
                                                            onToggle={() =>
                                                                toggleCollapsed(node.id)
                                                            }
                                                        />
                                                    ) : (
                                                        <span
                                                            className="size-6 shrink-0"
                                                            aria-hidden="true"
                                                        />
                                                    )}
                                                    {clippedDepth > 0 ? (
                                                        <span
                                                            className="shrink-0 text-[10px] font-medium text-muted-foreground"
                                                            aria-hidden="true"
                                                        >
                                                            +{clippedDepth}
                                                        </span>
                                                    ) : null}
                                                    <RowCount count={childCount} />
                                                    <span
                                                        className="min-w-0 flex-1 truncate text-sm"
                                                        title={title}
                                                    >
                                                        {title}
                                                    </span>
                                                </div>

                                                <div
                                                    className="flex min-w-0 items-center gap-2"
                                                    style={{
                                                        paddingLeft:
                                                            indentDepth * INDENT_STEP_PX,
                                                    }}
                                                >
                                                    <Progress
                                                        value={Math.min(
                                                            100,
                                                            Math.max(0, value),
                                                        )}
                                                        aria-hidden="true"
                                                        className={cn(
                                                            "h-2 w-16 shrink-0",
                                                            complete &&
                                                                "[&_[data-slot=progress-indicator]]:bg-success",
                                                        )}
                                                    />
                                                    <span className="sr-only">
                                                        {`${describeCompletionPercent(value)}, ${basis}`}
                                                    </span>
                                                    <span
                                                        aria-hidden="true"
                                                        className={cn(
                                                            "shrink-0 text-sm tabular-nums",
                                                            complete &&
                                                                "font-medium text-success",
                                                            muted && "text-muted-foreground",
                                                        )}
                                                    >
                                                        {formatCompletionPercent(value)}
                                                    </span>
                                                    {flagCopy === null ? null : (
                                                        <>
                                                            <span
                                                                className="shrink-0"
                                                                title={flagCopy}
                                                            >
                                                                <TriangleAlert
                                                                    className="size-3.5 text-warning"
                                                                    aria-hidden="true"
                                                                />
                                                            </span>
                                                            <span className="sr-only">
                                                                {flagCopy}
                                                            </span>
                                                        </>
                                                    )}
                                                    <span
                                                        className="min-w-0 truncate text-xs text-muted-foreground"
                                                        title={statusLabel}
                                                    >
                                                        {statusLabel}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                    <div aria-hidden="true" style={{ height: bottomSpacer }} />
                                </div>
                            ) : (
                                <Table
                                    role="treegrid"
                                    aria-label="Task completion"
                                    aria-rowcount={rows.length + 1}
                                    className="table-fixed border-separate border-spacing-0"
                                >
                                    <colgroup>
                                        <col />
                                        {showStatusColumn ? (
                                            <col style={{ width: STATUS_COLUMN_PX }} />
                                        ) : null}
                                        <col style={{ width: COMPLETE_COLUMN_PX }} />
                                        <col
                                            style={{
                                                width: isWideLayout
                                                    ? NOTE_COLUMN_PX
                                                    : NOTE_COMPACT_COLUMN_PX,
                                            }}
                                        />
                                    </colgroup>
                                    <TableHeader className="sticky top-0 z-10">
                                        <TableRow className="border-b-0 bg-card hover:bg-card [&>th]:shadow-[inset_0_-1px_0_var(--color-border)]">
                                            <TableHead scope="col" aria-rowindex={1}>
                                                Task
                                            </TableHead>
                                            {showStatusColumn ? (
                                                <TableHead scope="col">Status</TableHead>
                                            ) : null}
                                            <TableHead scope="col" className="td-num">
                                                Complete
                                            </TableHead>
                                            <TableHead scope="col">
                                                {isWideLayout ? (
                                                    "Note"
                                                ) : (
                                                    <span className="sr-only">Note</span>
                                                )}
                                            </TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        <tr aria-hidden="true" role="presentation">
                                            <td
                                                colSpan={columnCount}
                                                className="p-0"
                                                style={{ height: topSpacer }}
                                            />
                                        </tr>
                                        {virtualItems.map((item) => {
                                            const row = rows[item.index];
                                            if (row === undefined) return null;
                                            const { node, value, childCount, flag } = row;
                                            const hasChildren = childCount > 0;
                                            const isExpanded =
                                                hasChildren && !collapsedIds.has(node.id);
                                            const title = taskTitle(node);
                                            const indentDepth = Math.min(
                                                node.depth,
                                                MAX_INDENT_DEPTH,
                                            );
                                            const clippedDepth = node.depth - indentDepth;
                                            const complete = value >= 100;
                                            const muted = value <= 0;
                                            // A leaf in column mode scored from the chosen answer,
                                            // not its status, so the sentence must name that basis
                                            // to match the caption above the table.
                                            const basis = hasChildren
                                                ? `average of ${subtaskCountLabel(childCount)}`
                                                : mode === "status"
                                                  ? `status ${node.status?.label ?? NO_STATUS_LABEL}`
                                                  : `chosen answer in ${chosenField?.label ?? ""}`;
                                            const flagCopy =
                                                flag === null ? null : FLAG_COPY[flag];
                                            // Two lines: a parent always names its count; under "By
                                            // column" a leaf names the answer it was scored from.
                                            const answerLabel =
                                                mode === "column" && !hasChildren
                                                    ? (answerLabelById.get(
                                                          node.custom_values.find(
                                                              (entry) =>
                                                                  entry.field_id ===
                                                                  chosenField?.id,
                                                          )?.value ?? "",
                                                      ) ?? NO_ANSWER_LABEL)
                                                    : null;
                                            const subtitle = hasChildren
                                                ? subtaskCountLabel(childCount)
                                                : answerLabel;

                                            return (
                                                <TableRow
                                                    key={node.id}
                                                    ref={virtualizer.measureElement}
                                                    data-index={item.index}
                                                    data-slot="task-progress-row"
                                                    data-row-id={node.id}
                                                    aria-level={node.depth + 1}
                                                    aria-expanded={
                                                        hasChildren ? isExpanded : undefined
                                                    }
                                                    aria-rowindex={item.index + 2}
                                                    tabIndex={
                                                        node.id === rovingId ? 0 : -1
                                                    }
                                                    onFocus={() => setActiveId(node.id)}
                                                    onClick={
                                                        onOpenTask === undefined
                                                            ? undefined
                                                            : () => onOpenTask(node.id)
                                                    }
                                                    onKeyDown={(event) =>
                                                        activateOnKeyDown(event, node.id)
                                                    }
                                                    className={cn(
                                                        ROW_CLASS,
                                                        onOpenTask !== undefined &&
                                                            "cursor-pointer",
                                                    )}
                                                >
                                                    <th
                                                        scope="row"
                                                        className="px-2 py-2 text-left align-middle font-normal"
                                                    >
                                                        <div
                                                            className="flex min-w-0 items-start gap-1"
                                                            style={{
                                                                paddingLeft:
                                                                    indentDepth *
                                                                    INDENT_STEP_PX,
                                                            }}
                                                        >
                                                            {hasChildren ? (
                                                                <RowChevron
                                                                    title={title}
                                                                    expanded={isExpanded}
                                                                    onToggle={() =>
                                                                        toggleCollapsed(
                                                                            node.id,
                                                                        )
                                                                    }
                                                                />
                                                            ) : (
                                                                <span
                                                                    className="size-6 shrink-0"
                                                                    aria-hidden="true"
                                                                />
                                                            )}
                                                            {clippedDepth > 0 ? (
                                                                <span
                                                                    className="shrink-0 pt-0.5 text-[10px] font-medium text-muted-foreground"
                                                                    aria-hidden="true"
                                                                >
                                                                    +{clippedDepth}
                                                                </span>
                                                            ) : null}
                                                            {/* A two-line row needs the gap or its
                                                                height drops below the estimate. */}
                                                            <span
                                                                className={cn(
                                                                    "min-w-0 flex-1",
                                                                    subtitle !== null &&
                                                                        "space-y-1",
                                                                )}
                                                            >
                                                                <span
                                                                    className="block truncate text-sm"
                                                                    title={title}
                                                                >
                                                                    {title}
                                                                </span>
                                                                {subtitle === null ? null : (
                                                                    <span className="block truncate text-xs text-muted-foreground">
                                                                        {subtitle}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        </div>
                                                    </th>

                                                    {showStatusColumn ? (
                                                        <TableCell className="px-2 py-0 align-middle">
                                                            <TaskStatusBadge
                                                                status={node.status}
                                                            />
                                                        </TableCell>
                                                    ) : null}

                                                    <TableCell className="td-num px-2 py-1.5 align-middle">
                                                        <div className="flex items-center justify-end gap-2">
                                                            <Progress
                                                                value={Math.min(
                                                                    100,
                                                                    Math.max(0, value),
                                                                )}
                                                                aria-hidden="true"
                                                                className={cn(
                                                                    BAR_CLASS,
                                                                    complete &&
                                                                        "[&_[data-slot=progress-indicator]]:bg-success",
                                                                )}
                                                            />
                                                            {/* The bar is decorative; the sentence
                                                                is what a screen reader hears, and it
                                                                names the basis. */}
                                                            <span className="sr-only">
                                                                {`${describeCompletionPercent(value)}, ${basis}`}
                                                            </span>
                                                            <span
                                                                aria-hidden="true"
                                                                className={cn(
                                                                    "text-sm tabular-nums",
                                                                    complete &&
                                                                        "font-medium text-success",
                                                                    muted &&
                                                                        "text-muted-foreground",
                                                                )}
                                                            >
                                                                {formatCompletionPercent(value)}
                                                            </span>
                                                        </div>
                                                    </TableCell>

                                                    <TableCell
                                                        className={cn(
                                                            "align-middle whitespace-normal",
                                                            isWideLayout
                                                                ? "px-2 py-1.5"
                                                                : "px-0 py-1.5",
                                                        )}
                                                    >
                                                        {flagCopy === null ? null : isWideLayout ? (
                                                            <span className="flex min-w-0 items-center gap-1.5">
                                                                <TriangleAlert
                                                                    className="size-3 shrink-0 text-warning"
                                                                    aria-hidden="true"
                                                                />
                                                                <span
                                                                    className="min-w-0 truncate text-xs text-muted-foreground"
                                                                    title={flagCopy}
                                                                >
                                                                    {flagCopy}
                                                                </span>
                                                            </span>
                                                        ) : (
                                                            <span
                                                                className="flex items-center justify-center"
                                                                title={flagCopy}
                                                            >
                                                                <TriangleAlert
                                                                    className="size-3.5 shrink-0 text-warning"
                                                                    aria-hidden="true"
                                                                />
                                                                <span className="sr-only">
                                                                    {flagCopy}
                                                                </span>
                                                            </span>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })}
                                        <tr aria-hidden="true" role="presentation">
                                            <td
                                                colSpan={columnCount}
                                                className="p-0"
                                                style={{ height: bottomSpacer }}
                                            />
                                        </tr>
                                    </TableBody>
                                </Table>
                            )}
                        </div>
                    </div>

                    <p
                        data-slot="task-progress-footer"
                        className="text-xs text-muted-foreground"
                    >
                        {hiddenCount > 0
                            ? `Showing ${rows.length} of ${items.length} tasks`
                            : `${items.length} tasks`}
                    </p>
                </>
            ) : null}

            {noChosenAnswers ? (
                <p
                    data-slot="task-progress-no-answers"
                    className="rounded-xl border border-border/50 bg-card px-3 py-6 text-center text-sm text-muted-foreground"
                >
                    No task in this list carries one of these choices yet.
                </p>
            ) : null}
        </div>
    );
}

const SKELETON_ROWS: readonly string[] = [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
];

function ProgressSkeleton() {
    return (
        <div
            data-slot="task-progress-loading"
            role="status"
            aria-label="Loading tasks"
            className="w-full min-w-0 space-y-3"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Skeleton className="h-8 w-36 rounded-md" />
                <Skeleton className="h-8 w-40 rounded-md" />
            </div>
            <Skeleton className="h-4 w-72" />
            <div className="space-y-2 rounded-xl border border-border/50 bg-card p-3">
                {SKELETON_ROWS.map((row) => (
                    <Skeleton key={row} className="h-6 w-full rounded-md" />
                ))}
            </div>
            <span className="sr-only">Loading tasks…</span>
        </div>
    );
}

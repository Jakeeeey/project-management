"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type CSSProperties,
    type KeyboardEvent,
} from "react";
import {
    ChevronDown,
    ChevronRight,
    ChevronsDownUp,
    ChevronsUpDown,
    ListFilter,
    ListTree,
    RotateCcw,
    Search,
    SearchX,
    TriangleAlert,
    X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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

import { useSavedTaskFilters } from "../../hooks/useSavedTaskFilters";
import { useTaskFilterState } from "../../hooks/useTaskFilterState";
import type { TaskField, TaskListItem } from "../../hooks/useTasks";
import type { TaskTreeRow } from "../../hooks/useTaskTree";
import { assigneeName, type TaskViewProps } from "../../types/task-view";
import {
    columnWeightScore,
    completionFlag,
    computeCompletion,
    describeCompletionPercent,
    formatCompletionPercent,
    statusCompletionScore,
    type CompletionFlag,
    type CompletionRollup,
} from "../../utils/completion";
import { buildTree, flattenVisible, pruneForest, type TreeSourceRow, type TreeNode } from "../../utils/tree";
import { NO_STATUS_LABEL, TaskStatusBadge } from "../TaskRowBadges";
import { resolveTaskTags, TaskTagStack } from "../TaskTags";
import {
    TaskFilterBuilder,
    type FilterBuilderMember,
    type FilterBuilderOption,
} from "../TaskFilterBuilder";
import {
    anyClauseActive,
    cloneClausesForApply,
    failsExcludingClause as failsExcludingClauseRow,
    isClauseActive,
    rowMatchesClauses,
    type SavedTaskFilter,
} from "../task-filter";
import { buildOffsets, windowFor } from "./window";

/**
 * The Progress view: the department's tasks as a read-only completion tree-table.
 *
 * Every number here comes from {@link computeCompletion} — the one rollup — never from a local
 * average, so the two bases (a task's own status percentage, or the weight of the Choice-column
 * option it carries) can only differ in what a LEAF scores, never in how a parent is averaged.
 * Search and filters hide rows AFTER the rollup has run over the full list, which is why filtering
 * can never move a percentage: a parent's mean still covers every child, shown or hidden.
 *
 * The view owns its own UI state and nothing else: basis, column, sort order, which parents are
 * collapsed, and this tab's own search and filters (the List keeps its own). It never fetches and
 * never writes, so the shell stays the only owner of the rows and of retries.
 *
 * Only a window of rows is mounted, computed arithmetically in `./window` from the constants
 * below. That is what makes the tab survive a fully expanded tree: the DOM holds what is on
 * screen, not what the list contains.
 */

/**
 * What a LEAF scores. There are no modes: status weights are the default basis, and a Choice column
 * is an alternative one. A parent's mean is the same arithmetic either way.
 */
type ProgressBasis =
    | { readonly kind: "status" }
    | { readonly kind: "column"; readonly fieldId: number };

type ProgressSort = "tree" | "lowest";

const STATUS_BASIS_LABEL = "Status weights";

const SORT_LABELS: Record<ProgressSort, string> = {
    tree: "Tree order",
    lowest: "Lowest first",
};

/**
 * The visual indent step and its cap. A rail is painted every step, so the step is also the band
 * width: 20px in the table, 16px on a card, with the rail centred in each band (x = 10 + 20k).
 *
 * The cap is PRESENTATION ONLY — `aria-level` always carries the row's true depth, so a deep branch
 * reads correctly to a screen reader while the table stays narrow. Past the cap the outermost rail
 * clips and a `+n` marker reports the levels the indent cannot show.
 */
const TABLE_INDENT_STEP_PX = 20;
const TABLE_MAX_INDENT_DEPTH = 6;
const CARD_INDENT_STEP_PX = 16;
const CARD_MAX_INDENT_DEPTH = 4;

/** 80px on the number's left, so every row's bar lines up regardless of the digits beside it. */
const BAR_CLASS = "h-2 w-20 shrink-0";

/**
 * Geometry. A row is two lines when its parent carries the "N subtasks" count, or when the view is
 * grouped by a column and a leaf has to name the answer it scored from; otherwise it is one line.
 * Both numbers are FIXED: the row's cells add up to them whatever the text says, which is what
 * lets `./window` compute the offsets instead of measuring the DOM.
 *
 * Column widths come from a `<colgroup>`, so a recycled row can never reflow a column. And the row
 * hairline is an INSET SHADOW rather than a border, because a border adds to the box and every row
 * below it would drift half a pixel per row.
 */
const PARENT_ROW_HEIGHT_PX = 56;
const LEAF_ROW_HEIGHT_PX = 40;
const CARD_HEIGHT_PX = 72;
const OVERSCAN_ROWS = 10;
const STATUS_COLUMN_PX = 160;
/** Two circles plus the `+N` pill fit here; a tag cell only ever needs to be glanced at. */
const TAGS_COLUMN_PX = 96;
const COMPLETE_COLUMN_PX = 144;
const NOTE_COLUMN_PX = 256;
/** Below `xl` the Note cell holds the flag icon alone, so the column shrinks to the icon. */
const NOTE_COMPACT_COLUMN_PX = 40;
/**
 * The Task column's floor. The table is `table-fixed`, so without a floor a narrow container would
 * squeeze Status and Note below their declared widths and clip their labels instead of letting the
 * scroll box reach them.
 */
const TASK_COLUMN_MIN_PX = 220;
/**
 * The sticky `<thead>`'s height (`TableHead` is `h-10`). The row offsets index the BODY, which starts
 * below it, while `scrollTop` counts from the top of the scroll box — so an offset has to clear the
 * header before it can be compared with a scroll position. The card layout has no header.
 */
const STICKY_HEADER_PX = 40;
/** The air a row scrolled up to the header keeps above it, so it sits beside the header, not under it. */
const ROW_CLEARANCE_PX = 4;

/** 200ms of typing is one filter change; 400ms of quiet is one announcement. */
const SEARCH_DEBOUNCE_MS = 200;
const LIVE_REGION_DEBOUNCE_MS = 400;

/**
 * A body row's shared chrome. Nothing here pins a height: the row is 40px or 56px because its cells
 * are, and `./window` assumes exactly that.
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

/** A leaf's second line under "By column" when the task carries no answer for that column. */
const NOT_SET_LABEL = "Not set";
/** ... and when it carries an answer naming an option the column no longer offers. */
const REMOVED_CHOICE_LABEL = "Removed choice";

function subtaskCountLabel(count: number): string {
    return `${count} subtask${count === 1 ? "" : "s"}`;
}

function taskTitle(task: TaskListItem): string {
    return task.title.trim() === "" ? "Untitled task" : task.title;
}

/**
 * The rail colour: `--muted-foreground` at an alpha, so no new global token is needed. The alpha is
 * mode-split because that token flips direction — dark ink on white in light mode, pale ink on
 * near-black in dark mode — and one number cannot clear 3:1 on both grounds. 0.76 lands near
 * rgb(143,143,150) on white (3.21:1), 0.55 near rgb(102,102,109) on the dark card (3.38:1).
 *
 * It has to be set on the element that paints the gradient, since a custom property is read from the
 * box's own cascade. `--border` was the previous colour and measured 1.18:1 in dark mode.
 */
const RAIL_ALPHA_CLASS = "[--rail-alpha:0.76] dark:[--rail-alpha:0.55]";

/**
 * The depth rails, as an inline style because `background-size` is per-row data: an arbitrary
 * Tailwind class would be one class per depth per row, which defeats class hoisting across 77 rows.
 *
 * The gradient repeats every `stepPx`, so the band boundaries are arithmetic and never compress.
 * `background-size` is what terminates the set — a row paints rails for its ANCESTORS only, never
 * for its own band. The colour is `RAIL_ALPHA_CLASS`'s `--rail-alpha` over `--muted-foreground`.
 */
function railStyle(depth: number, stepPx: number): CSSProperties {
    return {
        backgroundImage: `repeating-linear-gradient(to right, hsl(var(--muted-foreground) / var(--rail-alpha)) 0 1px, transparent 1px ${stepPx}px)`,
        backgroundRepeat: "no-repeat",
        backgroundPositionX: `${stepPx / 2}px`,
        backgroundSize: `${depth * stepPx}px 100%`,
    };
}

/** A value that only moves once `delayMs` has passed without another change. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
    const [settled, setSettled] = useState(value);

    useEffect(() => {
        const timer = window.setTimeout(() => setSettled(value), delayMs);
        return () => window.clearTimeout(timer);
    }, [value, delayMs]);

    return settled;
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

/** What a leaf's answer to the chosen column turned out to be. */
type ColumnAnswerState =
    | { readonly kind: "set"; readonly label: string }
    | { readonly kind: "unset" }
    | { readonly kind: "removed" };

/** The per-row facts the table renders, resolved once per render for one visible node. */
interface ProgressNode {
    readonly node: TreeNode<TaskListItem>;
    readonly value: number;
    readonly own: number;
    /** Direct children in the FULL tree — the number the row's caption and badge report. */
    readonly childCount: number;
    /** Children the filter kept. Zero while `childCount` is not: every subtask was filtered out. */
    readonly visibleChildCount: number;
    readonly flag: CompletionFlag | null;
}

/**
 * A media query as state, for the two things CSS alone cannot do here: the card and table layouts
 * have different row heights, and the window needs the one that is actually mounted.
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
    memberNameById,
    isLoading,
    error,
    onRetry,
    onOpenTask,
}: TaskViewProps) {
    /** Status weights until the user picks a column from the `Complete` header's menu. */
    const [basis, setBasis] = useState<ProgressBasis>({ kind: "status" });
    const [sort, setSort] = useState<ProgressSort>("tree");
    /**
     * COLLAPSED ids, so the first paint is fully expanded without seeding a set from the rows.
     *
     * Each id carries the reveal chain that was in force when the reader collapsed it. A filter that
     * opens an ancestor must not undo a collapse the reader made after the filter appeared, and a
     * collapse made under one chain must not survive into the next one — a record rather than a bare
     * set, because both facts are about WHY the row is closed.
     */
    const [collapsedAt, setCollapsedAt] = useState<ReadonlyMap<number, string>>(
        () => new Map<number, string>(),
    );

    /**
     * The live filter, shared with the other tabs and persisted per browser (see
     * `useTaskFilterState`). The filter model is the List's clause model, not a second vocabulary, so
     * the tabs cannot drift; the debounce below treats the shared search box like a normal input.
     */
    const {
        search: searchInput,
        onSearchChange: setSearchInput,
        clauses,
        onClausesChange: setClauses,
        clearFilters: clearStoredFilters,
    } = useTaskFilterState();
    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const { savedFilters, saveFilter, deleteFilter } = useSavedTaskFilters();

    const settledSearch = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
    const search = settledSearch.trim().toLowerCase();
    const filterCount = clauses.filter(isClauseActive).length;
    const isFiltering = search !== "" || anyClauseActive(clauses);

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

    /** The column the basis names, resolved against the columns that still exist. */
    const chosenField = useMemo(
        () =>
            basis.kind === "column"
                ? (choiceFields.find((field) => field.id === basis.fieldId) ?? null)
                : null,
        [basis, choiceFields],
    );

    /** A column basis whose column has since been deleted or hidden falls back to status weights. */
    const isColumnBasis = basis.kind === "column" && chosenField !== null;

    const basisKey = isColumnBasis && chosenField !== null ? `column:${chosenField.id}` : "status";

    const scrollRef = useRef<HTMLDivElement | null>(null);

    /**
     * The scroll box's offset, sampled once per animation frame. `onScroll` fires far more often
     * than the window needs to move, and a state write per event would re-render the grid several
     * times in a frame; the pending offset is kept in a ref and the frame carries the latest one.
     */
    const [scrollTop, setScrollTop] = useState(0);
    const frameRef = useRef<number | null>(null);
    const pendingScrollTopRef = useRef(0);

    const handleScroll = useCallback(() => {
        const box = scrollRef.current;
        if (box === null) return;
        pendingScrollTopRef.current = box.scrollTop;
        if (frameRef.current !== null) return;
        frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = null;
            setScrollTop(pendingScrollTopRef.current);
        });
    }, []);

    useEffect(
        () => () => {
            if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        },
        [],
    );

    const handleBasisChange = useCallback((value: string) => {
        /**
         * Heights change with the basis — a leaf gains a second line under a column basis — so an
         * offset carried across would point at a different row. Reset here rather than in an effect:
         * this is the only thing that moves the basis, and the box cannot be scrolled by anything
         * else between the click and the render.
         */
        const box = scrollRef.current;
        box?.scrollTo({ top: 0 });
        setScrollTop(0);
        if (value === "status") {
            setBasis({ kind: "status" });
            return;
        }
        const fieldId = Number(value.slice("column:".length));
        if (Number.isFinite(fieldId)) setBasis({ kind: "column", fieldId });
    }, []);

    /** Option id -> its weight. This IS the column basis: a leaf scores the weight of the option it
     * carries, so `Deployed` 100 and `Staging` 10 differ. A column with no options scores every
     * leaf 0, which the rows then explain as "Removed choice" or "Not set".
     */
    const weightByOptionId = useMemo<ReadonlyMap<string, number>>(() => {
        const weights = new Map<string, number>();
        for (const option of chosenField?.options ?? []) {
            weights.set(String(option.id), option.completion_percent);
        }
        return weights;
    }, [chosenField]);

    /**
     * The one rollup. Status weights need no column, so there is always a basis to compute — a
     * column only changes what a LEAF scores, never how a parent is averaged.
     */
    const rollup = useMemo<CompletionRollup>(() => {
        if (isColumnBasis && chosenField !== null) {
            return computeCompletion(
                items,
                columnWeightScore<TaskListItem>(chosenField.id, weightByOptionId),
            );
        }
        return computeCompletion(items, statusCompletionScore(percentByStatusId));
    }, [items, isColumnBasis, chosenField, weightByOptionId, percentByStatusId]);

    const forest = useMemo(() => {
        const roots = buildTree(items);
        if (sort === "lowest") sortSiblingsByValue(roots, rollup.valueById);
        return roots;
    }, [items, sort, rollup]);

    const parentById = useMemo(() => {
        const parents = new Map<number, number | null>();
        for (const item of items) parents.set(item.id, item.parent_id);
        return parents;
    }, [items]);

    /**
     * The rows the clause model can read. `TaskTreeRow` is what the List's evaluator takes, and the
     * only thing `TaskListItem` lacks is the assignee's name — which the directory already holds.
     */
    const filterRows = useMemo<TaskTreeRow[]>(
        () =>
            items.map((item) => ({
                ...item,
                assignees: item.assignees.map((assignee) => ({
                    user_id: assignee.user_id,
                    full_name: assigneeName(assignee.user_id, memberNameById),
                })),
            })),
        [items, memberNameById],
    );

    const filterRowById = useMemo(() => {
        const byId = new Map<number, TaskTreeRow>();
        for (const row of filterRows) byId.set(row.id, row);
        return byId;
    }, [filterRows]);

    /**
     * The rows that MATCH — the same `rowMatchesClauses` the List runs, so a clause means the same
     * thing on both tabs. Percentages and counts still come from the full rollup, which is why
     * filtering can hide a row but never move a number.
     */
    const matchedIds = useMemo(() => {
        const ids = new Set<number>();
        for (const row of filterRows) {
            if (search !== "" && !row.title.toLowerCase().includes(search)) continue;
            if (!rowMatchesClauses(row, clauses, fields)) continue;
            ids.add(row.id);
        }
        return ids;
    }, [filterRows, search, clauses, fields]);

    /**
     * The forest the grid renders: `pruneForest` — the List's rule, both clause directions included —
     * so a row a negative clause excludes takes its whole subtree with it, while a row a positive
     * clause selects keeps its children on screen.
     */
    const renderForest = useMemo(() => {
        if (!isFiltering) return forest;
        return pruneForest(forest, {
            passesClauses: (row) => {
                const filterRow = filterRowById.get(row.id);
                return filterRow !== undefined && rowMatchesClauses(filterRow, clauses, fields);
            },
            failsExcludingClause: (row) => {
                const filterRow = filterRowById.get(row.id);
                return filterRow !== undefined && failsExcludingClauseRow(filterRow, clauses, fields);
            },
            ...(search === "" ? {} : { matchesSearch: (row: TaskListItem) => row.title.toLowerCase().includes(search) }),
        });
    }, [isFiltering, forest, filterRowById, clauses, fields, search]);

    /** Parents that survive the filter — the only ids `flattenVisible` and Collapse all care about. */
    const renderParentIds = useMemo(() => {
        const ids = new Set<number>();
        const stack: TreeNode<TaskListItem>[] = [...renderForest];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === undefined) continue;
            if (node.children.length === 0) continue;
            ids.add(node.id);
            for (const child of node.children) stack.push(child);
        }
        return ids;
    }, [renderForest]);

    /**
     * The chain a filter must open to put its matches on screen: every ancestor of every match,
     * encoded as one content key. A STRING on purpose — `matchedIds` and `parentById` are rebuilt
     * whenever `items` changes, so an id array would be a new identity on every refetch and would
     * re-open a row the reader had just collapsed. Content is the only thing this may react to.
     */
    const revealKey = useMemo(() => {
        if (!isFiltering) return "";
        const chain = new Set<number>();
        for (const id of matchedIds) {
            let cursor = parentById.get(id) ?? null;
            while (cursor !== null && !chain.has(cursor)) {
                chain.add(cursor);
                cursor = parentById.get(cursor) ?? null;
            }
        }
        return [...chain].sort((a, b) => a - b).join(",");
    }, [isFiltering, matchedIds, parentById]);

    const revealedIds = useMemo<ReadonlySet<number>>(() => {
        if (revealKey === "") return new Set<number>();
        return new Set(revealKey.split(",").map(Number));
    }, [revealKey]);

    /**
     * The collapse state the grid actually renders. A row the current chain reached is OPEN unless
     * the reader closed it under this same chain; everything else is closed exactly when the reader
     * closed it. Nothing here writes to state, so a filter can reveal a row without the render having
     * to schedule another one first.
     */
    const collapsedIds = useMemo<ReadonlySet<number>>(() => {
        const ids = new Set<number>();
        for (const [id, closedUnder] of collapsedAt) {
            if (closedUnder === revealKey || !revealedIds.has(id)) ids.add(id);
        }
        return ids;
    }, [collapsedAt, revealKey, revealedIds]);

    const expandedIds = useMemo(() => {
        const ids = new Set<number>();
        for (const id of renderParentIds) if (!collapsedIds.has(id)) ids.add(id);
        return ids;
    }, [renderParentIds, collapsedIds]);

    const visible = useMemo(
        () => flattenVisible(renderForest, expandedIds),
        [renderForest, expandedIds],
    );

    const rows = useMemo<ProgressNode[]>(
        () =>
            visible.map((node) => {
                const value = rollup.valueById.get(node.id) ?? 0;
                const own = rollup.ownById.get(node.id) ?? 0;
                const childCount = rollup.childCountById.get(node.id) ?? 0;
                return {
                    node,
                    value,
                    own,
                    childCount,
                    visibleChildCount: node.children.length,
                    flag: completionFlag(own, value, childCount),
                };
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

    /**
     * The window's height, read from the scroll box's own box, never guessed from the viewport: the
     * box is capped by `max-h` and shrinks to its content below that. It cannot be read during
     * render — the box is laid out after the commit — so it is state, seeded on mount and re-read
     * on a resize and whenever the row count changes, which is when the box's content height does.
     */
    const [viewportHeight, setViewportHeight] = useState(0);

    useEffect(() => {
        const box = scrollRef.current;
        if (box === null) return;
        const readHeight = () => setViewportHeight(box.clientHeight);
        readHeight();
        window.addEventListener("resize", readHeight);
        return () => window.removeEventListener("resize", readHeight);
    }, [isCardLayout, rows.length]);

    /**
     * The row heights, as constants: a card is one fixed box, and a table row is two lines when it
     * shows a count or an answer, one otherwise. Nothing here is measured, so nothing can drift.
     */
    const rowHeights = useMemo(() => {
        if (isCardLayout) return rows.map(() => CARD_HEIGHT_PX);
        return rows.map((row) =>
            row.childCount > 0 || isColumnBasis ? PARENT_ROW_HEIGHT_PX : LEAF_ROW_HEIGHT_PX,
        );
    }, [rows, isCardLayout, isColumnBasis]);

    const rowOffsets = useMemo(() => buildOffsets(rowHeights), [rowHeights]);

    const rowWindow = useMemo(
        () => windowFor(rowOffsets, scrollTop, viewportHeight, OVERSCAN_ROWS),
        [rowOffsets, scrollTop, viewportHeight],
    );

    const toggleCollapsed = useCallback(
        (id: number) => {
            const isClosed = collapsedIds.has(id);
            setCollapsedAt((previous) => {
                const next = new Map(previous);
                // The chain that is open right now is what a later filter compares against, so a
                // collapse made under it is the one that outranks the reveal.
                if (isClosed) next.delete(id);
                else next.set(id, revealKey);
                return next;
            });
        },
        [collapsedIds, revealKey],
    );

    /**
     * True while a parent ON SCREEN is open — the Collapse all / Expand all label's source.
     *
     * Visible rows only: a collapsed parent's children are off screen, so their own expansion state
     * cannot be what the button is about to change. Counting them would offer "Collapse all" over a
     * screen holding one collapsed row, which is a promise the click cannot keep.
     */
    const anyExpanded = useMemo(
        () => rows.some((row) => row.visibleChildCount > 0 && !collapsedIds.has(row.node.id)),
        [rows, collapsedIds],
    );

    /**
     * One button, two directions, scoped to what the filter left on screen: it must never report
     * "Collapse all" while nothing it can reach is open. Ids hidden by the filter keep their state.
     */
    const toggleAll = useCallback(() => {
        setCollapsedAt((previous) => {
            const next = new Map(previous);
            for (const id of renderParentIds) {
                if (anyExpanded) next.set(id, revealKey);
                else next.delete(id);
            }
            return next;
        });
    }, [anyExpanded, renderParentIds, revealKey]);

    const clearFilterClauses = useCallback(() => setClauses([]), [setClauses]);

    /** The toolbar's affordance and the empty state both reset search AND filters. */
    const clearAllFilters = useCallback(() => {
        clearStoredFilters();
    }, [clearStoredFilters]);

    /**
     * Focus moves by id, not by element: the row the keyboard asked for is usually not mounted yet
     * when the handler runs. The scroll below mounts it on the next frame, so this retries for a
     * few frames and then stops rather than fighting the user for focus.
     */
    const focusRowAt = useCallback(
        (index: number) => {
            const clamped = Math.min(Math.max(index, 0), rows.length - 1);
            const target = rows[clamped];
            if (target === undefined) return;
            const id = target.node.id;
            setActiveId(id);

            /**
             * The row scrolls only if it is out of view, and the top edge it has to clear is the
             * sticky header rather than the box: `ROW_CLEARANCE_PX` is the air it keeps above itself,
             * and in the table layout the header's own height is added back because the offsets are
             * body-relative while `scrollTop` counts from the top of the box. Both branches are
             * written from the offsets, which are the same numbers the spacers and the window use.
             */
            const box = scrollRef.current;
            if (box !== null && box.clientHeight > 0) {
                const top = rowOffsets[clamped] ?? 0;
                const bottom = rowOffsets[clamped + 1] ?? top;
                const headerPx = isCardLayout ? 0 : STICKY_HEADER_PX;
                let next = box.scrollTop;
                if (top - ROW_CLEARANCE_PX < next) {
                    next = top - ROW_CLEARANCE_PX;
                } else if (bottom + headerPx > next + box.clientHeight) {
                    next = bottom + headerPx - box.clientHeight;
                }
                next = Math.max(0, next);
                if (next !== box.scrollTop) {
                    box.scrollTo({ top: next });
                    setScrollTop(next);
                }
            }

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
        [rows, rowOffsets, isCardLayout],
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
            // Expansion follows what is on screen: a parent whose children were all filtered out
            // has nothing to open, so Right steps on instead of toggling an invisible subtree.
            const hasChildren = current.visibleChildCount > 0;
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

    const filterStatuses = useMemo<FilterBuilderOption[]>(
        () =>
            catalogs.statuses.map((status) => ({
                id: status.id,
                label: status.label,
                color: status.color,
            })),
        [catalogs.statuses],
    );

    const filterPriorities = useMemo<FilterBuilderOption[]>(
        () =>
            catalogs.priorities.map((priority) => ({
                id: priority.id,
                label: priority.label,
                color: priority.color,
            })),
        [catalogs.priorities],
    );

    const filterTags = useMemo<FilterBuilderOption[]>(
        () =>
            catalogs.tags.map((tag) => ({
                id: tag.id,
                label: tag.label,
                color: tag.color,
            })),
        [catalogs.tags],
    );

    /** Only members who actually hold a task in this list: an empty filter group is noise. */
    const filterMembers = useMemo<FilterBuilderMember[]>(() => {
        const ids = new Set<number>();
        for (const item of items) {
            for (const assignee of item.assignees) ids.add(assignee.user_id);
        }
        return [...ids]
            .map((id) => ({ user_id: id, full_name: assigneeName(id, memberNameById) }))
            .sort((a, b) => a.full_name.localeCompare(b.full_name));
    }, [items, memberNameById]);

    /** A saved set restores fresh clause rows, so its ids never collide with the live ones. */
    const applySavedFilter = useCallback(
        (filter: SavedTaskFilter) => {
            setClauses(cloneClausesForApply(filter.clauses));
        },
        [setClauses],
    );

    const statusPercentsUnset = useMemo(
        () => catalogs.statuses.every((status) => status.completion_percent === 0),
        [catalogs.statuses],
    );

    /**
     * A column whose options all weigh 0 scores every leaf 0 — worth saying, not worth guessing at.
     * A column with NO options is a different state (nothing can carry an answer), and `every` is
     * vacuously true on an empty array, so the length guard has to come first.
     */
    const columnWeightsAllZero = useMemo(
        () =>
            chosenField !== null &&
            chosenField.options.length > 0 &&
            chosenField.options.every((option) => option.completion_percent === 0),
        [chosenField],
    );

    /** The polite count, debounced so typing does not narrate every keystroke. */
    const announcedCount = useDebouncedValue(rows.length, LIVE_REGION_DEBOUNCE_MS);

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

    /**
     * Under status weights the status IS the basis, so its column would repeat the bar's sentence;
     * the table drops it and the spacer rows' `colSpan` has to follow the real count, or every cell
     * after the phantom column shifts one place right.
     */
    const showStatusColumn = isColumnBasis;
    const columnCount = showStatusColumn ? 5 : 4;
    const tableMinWidthPx =
        TASK_COLUMN_MIN_PX +
        TAGS_COLUMN_PX +
        (showStatusColumn ? STATUS_COLUMN_PX : 0) +
        COMPLETE_COLUMN_PX +
        (isWideLayout ? NOTE_COLUMN_PX : NOTE_COMPACT_COLUMN_PX);

    const filterLabel =
        filterCount === 0 ? "Filters" : filterCount === 1 ? "1 filter" : `${filterCount} filters`;
    const filterAriaLabel =
        filterCount === 0 ? "Filters, none active" : `Filters, ${filterCount} active`;

    /**
     * The window. `offsets[start]` is the height of everything above it in the flattened list and
     * `total - offsets[end]` is the height of everything below, so two spacers reproduce the real
     * scroll height without mounting a row: offsets stay arithmetic, never a transform.
     */
    const windowRows = rows.slice(rowWindow.start, rowWindow.end);
    const totalHeight = rowOffsets[rowOffsets.length - 1] ?? 0;
    const topSpacer = rowOffsets[rowWindow.start] ?? 0;
    const bottomSpacer = Math.max(0, totalHeight - (rowOffsets[rowWindow.end] ?? totalHeight));

    return (
        <div data-slot="task-progress" className="w-full min-w-0 space-y-3">
            {/* The same shell as the List's toolbar, so the two tabs read as one surface. */}
            <div
                data-slot="task-progress-toolbar"
                className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-3 shadow-sm sm:flex-row sm:items-center"
            >
                <div className="relative min-w-0 sm:max-w-md sm:flex-1">
                    <Search
                        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <Input
                        type="search"
                        value={searchInput}
                        onChange={(event) => setSearchInput(event.target.value)}
                        placeholder="Search tasks by title"
                        aria-label="Search tasks by title"
                        className="pl-8"
                    />
                </div>

                <div className="flex flex-wrap items-center gap-2 sm:ml-auto">

                    <Dialog open={isFilterOpen} onOpenChange={setIsFilterOpen}>
                        <DialogTrigger asChild>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                data-slot="task-progress-filter-trigger"
                                aria-label={filterAriaLabel}
                                title={filterAriaLabel}
                                className={cn(
                                    "shrink-0 gap-1.5 rounded-full",
                                    filterCount > 0 &&
                                        "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25",
                                )}
                            >
                                <ListFilter className="size-4" aria-hidden="true" />
                                {filterLabel}
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="w-[95vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[720px]">
                            <DialogHeader className="border-b px-6 pt-6 pb-4">
                                <DialogTitle>Filters</DialogTitle>
                                <DialogDescription>
                                    Add rows to narrow the list of tasks.
                                </DialogDescription>
                            </DialogHeader>
                            <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
                                <TaskFilterBuilder
                                    clauses={clauses}
                                    onClausesChange={setClauses}
                                    fields={fields}
                                    statuses={filterStatuses}
                                    priorities={filterPriorities}
                                    tags={filterTags}
                                    members={filterMembers}
                                    currentUserId={null}
                                    savedFilters={savedFilters}
                                    onSaveFilter={saveFilter}
                                    onApplySavedFilter={applySavedFilter}
                                    onDeleteSavedFilter={deleteFilter}
                                />
                            </div>
                            <DialogFooter className="justify-end border-t bg-muted/20 px-6 py-4">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    data-slot="task-filter-clear-all"
                                    onClick={clearFilterClauses}
                                    disabled={clauses.length === 0}
                                >
                                    Clear all filters
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setIsFilterOpen(false)}
                                >
                                    Done
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>

                    {isFiltering ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={clearAllFilters}
                            className="shrink-0 gap-1.5 text-muted-foreground"
                        >
                            <X className="size-4" aria-hidden="true" />
                            Clear filters
                        </Button>
                    ) : null}

                    <Select
                        value={sort}
                        onValueChange={(next) => setSort(next as ProgressSort)}
                    >
                        <SelectTrigger
                            size="sm"
                            className="w-40 shrink-0 rounded-full"
                            aria-label="Sort tasks"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="tree">{SORT_LABELS.tree}</SelectItem>
                            <SelectItem value="lowest">{SORT_LABELS.lowest}</SelectItem>
                        </SelectContent>
                    </Select>

                    {renderParentIds.size > 0 ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={toggleAll}
                            title={
                                anyExpanded ? "Collapse every subtask" : "Expand every subtask"
                            }
                            className="shrink-0 gap-1.5 rounded-full"
                        >
                            {anyExpanded ? (
                                <ChevronsDownUp className="size-4" aria-hidden="true" />
                            ) : (
                                <ChevronsUpDown className="size-4" aria-hidden="true" />
                            )}
                            {anyExpanded ? "Collapse all" : "Expand all"}
                        </Button>
                    ) : null}
                </div>
            </div>

            {/* Mounted once and never re-created: a live region has to exist before it can speak. */}
            <span
                data-slot="task-progress-live"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
            >
                {`${announcedCount} of ${items.length} tasks shown.`}
            </span>

            {!isColumnBasis && statusPercentsUnset ? (
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

            {chosenField !== null && !chosenField.is_enabled ? (
                <p data-slot="task-progress-hidden-column" className="text-xs text-muted-foreground">
                    This column is hidden from the task list. Showing the answers already saved.
                </p>
            ) : null}

            {columnWeightsAllZero && chosenField !== null ? (
                <div
                    data-slot="task-progress-zero-weights"
                    className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
                >
                    <TriangleAlert className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden="true" />
                    <span>
                        {`Every option in "${chosenField.label}" has a weight of 0, so every task shows 0%. Set the weights on the column's options.`}
                    </span>
                </div>
            ) : null}

            {rows.length > 0 ? (
                <>
                    <div className="rounded-xl border border-border/50 bg-card">
                        <div
                            ref={scrollRef}
                            role="group"
                            // Not a tab stop: the roving row is the grid's ONE stop (see
                            // `rovingId`). The box stays focusable programmatically, which is what
                            // the wheel handler uses to take focus off a row about to unmount.
                            tabIndex={-1}
                            aria-label="Task completion"
                            onKeyDown={handleGridKeyDown}
                            onScroll={handleScroll}
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
                                    {windowRows.map((row, offset) => {
                                        const index = rowWindow.start + offset;
                                        const {
                                            node,
                                            value,
                                            childCount,
                                            visibleChildCount,
                                            flag,
                                        } = row;
                                        const hasChildren = childCount > 0;
                                        const hasVisibleChildren = visibleChildCount > 0;
                                        const childrenHidden =
                                            hasChildren && !hasVisibleChildren;
                                        const isExpanded =
                                            hasVisibleChildren && !collapsedIds.has(node.id);
                                        const title = taskTitle(node);
                                        const statusLabel =
                                            node.status?.label ?? NO_STATUS_LABEL;
                                        const indentDepth = Math.min(
                                            node.depth,
                                            CARD_MAX_INDENT_DEPTH,
                                        );
                                        const clippedDepth = node.depth - indentDepth;
                                        const complete = value >= 100;
                                        const muted = value <= 0;
                                        const answer =
                                            isColumnBasis && !hasChildren
                                                ? resolveColumnAnswer(node, chosenField)
                                                : null;
                                        const trailing =
                                            isColumnBasis && answer !== null
                                                ? answerLabel(answer)
                                                : statusLabel;
                                        const basis = hasChildren
                                            ? `average of ${subtaskCountLabel(childCount)}${childrenHidden ? ", none match." : ""}`
                                            : isColumnBasis
                                              ? answerBasis(answer, chosenField?.label ?? "")
                                              : `status ${statusLabel}`;
                                        const flagCopy =
                                            flag === null ? null : FLAG_COPY[flag];

                                        return (
                                            <div
                                                key={node.id}
                                                data-index={index}
                                                role="treeitem"
                                                data-slot="task-progress-card"
                                                data-row-id={node.id}
                                                aria-level={node.depth + 1}
                                                aria-expanded={
                                                    hasVisibleChildren
                                                        ? isExpanded
                                                        : undefined
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
                                                    className={cn(
                                                        "flex min-w-0 items-center gap-1",
                                                        RAIL_ALPHA_CLASS,
                                                    )}
                                                    style={{
                                                        paddingLeft:
                                                            indentDepth * CARD_INDENT_STEP_PX,
                                                        ...railStyle(
                                                            indentDepth,
                                                            CARD_INDENT_STEP_PX,
                                                        ),
                                                    }}
                                                >
                                                    {hasVisibleChildren ? (
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
                                                    <span
                                                        className="w-4 shrink-0 text-center text-xs tabular-nums text-muted-foreground"
                                                        aria-hidden="true"
                                                    >
                                                        {clippedDepth > 0
                                                            ? `+${clippedDepth}`
                                                            : ""}
                                                    </span>
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
                                                            indentDepth * CARD_INDENT_STEP_PX,
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
                                                        title={trailing}
                                                    >
                                                        {trailing}
                                                    </span>
                                                    {/* A card has no room for an empty tag glyph, so
                                                        the stack only appears when there is one. */}
                                                    {resolveTaskTags(node.tags, catalogs.tags)
                                                        .length > 0 ? (
                                                        <TaskTagStack
                                                            tags={resolveTaskTags(
                                                                node.tags,
                                                                catalogs.tags,
                                                            )}
                                                            max={2}
                                                            className="shrink-0"
                                                        />
                                                    ) : null}
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
                                    style={{ minWidth: tableMinWidthPx }}
                                    className="table-fixed border-separate border-spacing-0"
                                >
                                    <colgroup>
                                        <col />
                                        <col style={{ width: TAGS_COLUMN_PX }} />
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
                                            <TableHead scope="col" className="text-center">
                                                Tags
                                            </TableHead>
                                            {showStatusColumn ? (
                                                <TableHead scope="col">Status</TableHead>
                                            ) : null}
                                            <TableHead scope="col" className="td-num">
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="xs"
                                                            data-slot="task-progress-basis"
                                                            aria-label={
                                                                chosenField !== null
                                                                    ? `Completion basis, currently ${chosenField.label}`
                                                                    : "Completion basis, currently status weights"
                                                            }
                                                            title={
                                                                chosenField !== null
                                                                    ? `Completion basis, currently ${chosenField.label}`
                                                                    : "Completion basis, currently status weights"
                                                            }
                                                            className="-ml-1.5 gap-1 px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                                                        >
                                                            {chosenField !== null
                                                                ? `Complete · ${chosenField.label}`
                                                                : "Complete"}
                                                            <ChevronDown
                                                                className="size-3.5"
                                                                aria-hidden="true"
                                                            />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end" className="w-56">
                                                        <DropdownMenuLabel>
                                                            Completion basis
                                                        </DropdownMenuLabel>
                                                        <DropdownMenuSeparator />
                                                        <DropdownMenuRadioGroup
                                                            value={basisKey}
                                                            onValueChange={handleBasisChange}
                                                        >
                                                            <DropdownMenuRadioItem value="status">
                                                                {STATUS_BASIS_LABEL}
                                                            </DropdownMenuRadioItem>
                                                            {choiceFields.map((field) => (
                                                                <DropdownMenuRadioItem
                                                                    key={field.id}
                                                                    value={`column:${field.id}`}
                                                                >
                                                                    {field.label}
                                                                </DropdownMenuRadioItem>
                                                            ))}
                                                        </DropdownMenuRadioGroup>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
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
                                        {windowRows.map((row, offset) => {
                                            const index = rowWindow.start + offset;
                                            const {
                                                node,
                                                value,
                                                childCount,
                                                visibleChildCount,
                                                flag,
                                            } = row;
                                            const hasChildren = childCount > 0;
                                            const hasVisibleChildren = visibleChildCount > 0;
                                            const childrenHidden =
                                                hasChildren && !hasVisibleChildren;
                                            const isExpanded =
                                                hasVisibleChildren &&
                                                !collapsedIds.has(node.id);
                                            const title = taskTitle(node);
                                            const indentDepth = Math.min(
                                                node.depth,
                                                TABLE_MAX_INDENT_DEPTH,
                                            );
                                            const clippedDepth = node.depth - indentDepth;
                                            const complete = value >= 100;
                                            const muted = value <= 0;
                                            // A leaf under a column basis scored from the weight of
                                            // its answer, so the sentence must name that basis to
                                            // match the caption above the table.
                                            const answer =
                                                isColumnBasis && !hasChildren
                                                    ? resolveColumnAnswer(node, chosenField)
                                                    : null;
                                            const basis = hasChildren
                                                ? `average of ${subtaskCountLabel(childCount)}${childrenHidden ? ", none match." : ""}`
                                                : isColumnBasis
                                                  ? answerBasis(
                                                        answer,
                                                        chosenField?.label ?? "",
                                                    )
                                                  : `status ${node.status?.label ?? NO_STATUS_LABEL}`;
                                            const flagCopy =
                                                flag === null ? null : FLAG_COPY[flag];
                                            // Two lines: a parent always names its count; under "By
                                            // column" a leaf names the answer it was scored from.
                                            const subtitle = hasChildren
                                                ? childrenHidden
                                                    ? `${subtaskCountLabel(childCount)}, none match`
                                                    : subtaskCountLabel(childCount)
                                                : answer === null
                                                  ? null
                                                  : answerLabel(answer);

                                            return (
                                                <TableRow
                                                    key={node.id}
                                                    data-index={index}
                                                    data-slot="task-progress-row"
                                                    data-row-id={node.id}
                                                    aria-level={node.depth + 1}
                                                    aria-expanded={
                                                        hasVisibleChildren
                                                            ? isExpanded
                                                            : undefined
                                                    }
                                                    aria-rowindex={index + 2}
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
                                                        className={cn(
                                                            "px-2 py-2 text-left align-middle font-normal",
                                                            RAIL_ALPHA_CLASS,
                                                        )}
                                                        style={railStyle(
                                                            indentDepth,
                                                            TABLE_INDENT_STEP_PX,
                                                        )}
                                                    >
                                                        <div
                                                            className="flex min-w-0 items-start gap-1"
                                                            style={{
                                                                paddingLeft:
                                                                    indentDepth *
                                                                    TABLE_INDENT_STEP_PX,
                                                            }}
                                                        >
                                                            {hasVisibleChildren ? (
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
                                                            <span
                                                                className="w-4 shrink-0 pt-0.5 text-center text-xs tabular-nums text-muted-foreground"
                                                                aria-hidden="true"
                                                            >
                                                                {clippedDepth > 0
                                                                    ? `+${clippedDepth}`
                                                                    : ""}
                                                            </span>
                                                            {/* The gap is part of the 56px
                                                                two-line row, not decoration. */}
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

                                                    <TableCell className="px-2 py-1.5 align-middle">
                                                        <div className="flex justify-center">
                                                            <TaskTagStack
                                                                tags={resolveTaskTags(
                                                                    node.tags,
                                                                    catalogs.tags,
                                                                )}
                                                                max={2}
                                                                emptyVariant="icon"
                                                            />
                                                        </div>
                                                    </TableCell>

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
                        {/* The shown count is what is on screen, so collapsing a parent lowers it
                            exactly as a filter does. The percentages are not that count: they cover
                            every task in the list whether it is filtered out or folded away. */}
                        {isFiltering
                            ? `Showing ${rows.length} of ${items.length} tasks. Percentages cover all ${items.length} tasks.`
                            : `${items.length} tasks`}
                    </p>
                </>
            ) : null}

            {rows.length === 0 ? (
                <div
                    data-slot="task-progress-no-matches"
                    className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/50 bg-card px-4 py-10 text-center"
                >
                    <SearchX className="size-8 text-muted-foreground/50" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">
                        No tasks match the current search and filters.
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={clearAllFilters}>
                        Clear filters
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

/** The second line a column-scored leaf shows: the option it carries, or why it scores nothing. */
function answerLabel(answer: ColumnAnswerState): string {
    if (answer.kind === "set") return answer.label;
    if (answer.kind === "removed") return REMOVED_CHOICE_LABEL;
    return NOT_SET_LABEL;
}

/** The same fact, as the tail of the row's spoken sentence. */
function answerBasis(answer: ColumnAnswerState | null, columnLabel: string): string {
    if (answer === null) return `no answer in ${columnLabel}`;
    if (answer.kind === "set") return `answer ${answer.label} in ${columnLabel}`;
    if (answer.kind === "removed") return `a removed choice in ${columnLabel}`;
    return `no answer in ${columnLabel}`;
}

/**
 * The option a task carries in the chosen column, or why there is none.
 *
 * A task with no answer and a task whose answer names a deleted option both score 0, but they are
 * not the same fact: one is work nobody has graded, the other is a choice that no longer exists.
 * The row's second line says which.
 */
function resolveColumnAnswer(
    task: TaskListItem,
    field: TaskField | null,
): ColumnAnswerState {
    if (field === null) return { kind: "unset" };
    let carried: string | null | undefined;
    for (const answer of task.custom_values) {
        if (answer.field_id !== field.id) continue;
        carried = answer.value;
        break;
    }
    if (carried === undefined || carried === null) return { kind: "unset" };
    const option = field.options.find((entry) => String(entry.id) === carried);
    if (option === undefined) return { kind: "removed" };
    return { kind: "set", label: option.label };
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

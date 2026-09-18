"use client";

import {
    cloneElement,
    createContext,
    isValidElement,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import {
    closestCenter,
    DndContext,
    DragOverlay,
    KeyboardSensor,
    pointerWithin,
    PointerSensor,
    useSensor,
    useSensors,
    type CollisionDetection,
    type DragEndEvent,
    type DragMoveEvent,
    type DragOverEvent,
    type DragStartEvent,
    type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { hasViewportRelativeCoordinates } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import { flattenVisible, type TreeNode } from "../../utils/tree";
import { type MoveTaskInput } from "@/modules/project-management/task-management/tasks/types/pm-task.schema";

import { TaskPriorityBadge, TaskStatusBadge } from "../TaskRowBadges";
import type { TaskRowView } from "../TaskRow";
import {
    cycleDropIntent,
    droppableTargetIds,
    resolveDropDestination,
    resolveDropIntent,
    type DndRow,
    type DropIntent,
    type FlatRow,
    type MovePayload,
} from "./dnd-logic";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** How long the pointer must dwell on a collapsed parent before it springs open for nesting. */
const AUTO_EXPAND_DELAY_MS = 500;

/** The intent a keyboard drag starts on: a plain reorder until Left/Right cycle it. */
const KEYBOARD_START_INTENT: DropIntent = "after";

/** The overlay's action label — the human name of each resolved intent. */
const INTENT_LABELS: Record<DropIntent, string> = {
    before: "Insert before",
    nest: "Make sub-task",
    after: "Insert after",
};

function subscribeReducedMotion(onStoreChange: () => void): () => void {
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    query.addEventListener("change", onStoreChange);
    return () => query.removeEventListener("change", onStoreChange);
}

function getReducedMotionSnapshot(): boolean {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getReducedMotionServerSnapshot(): boolean {
    return false;
}

/**
 * `true` once the user prefers reduced motion, including when they flip the setting mid-session.
 *
 * Used to drop the animated transform/drop transitions while KEEPING the drop indicators and the
 * drag overlay — motion is reduced, feedback is not removed.
 */
export function usePrefersReducedMotion(): boolean {
    return useSyncExternalStore(
        subscribeReducedMotion,
        getReducedMotionSnapshot,
        getReducedMotionServerSnapshot,
    );
}

/** Everything a row needs to know about the drag currently in flight. */
export interface TreeDndContextValue {
    /** The row being dragged, or `null` when no drag is active. */
    readonly activeId: number | null;
    /** The row currently under the pointer (or the keyboard's cursor row). */
    readonly overId: number | null;
    /** Resolved drop intent for the current `over` row, or `null` when there is none. */
    readonly intent: DropIntent | null;
    /**
     * The depth the resolved drop will actually apply, or `null` when the current over is not a
     * valid drop. It is the SAME value the payload was resolved from — never a second projection.
     */
    readonly resolvedDepth: number | null;
    /** True while a filter or search is active; every handle is disabled and no drop is emitted. */
    readonly isReorderDisabled: boolean;
    /** The complete flat row set — hidden rows included, so the cycle guard sees the whole tree. */
    readonly rows: readonly DndRow[];
}

const TreeDndContext = createContext<TreeDndContextValue | null>(null);

/** The drag state for the nearest `TreeDndProvider`. Throws when used outside one. */
export function useTreeDnd(): TreeDndContextValue {
    const value = useContext(TreeDndContext);
    if (value === null) {
        throw new Error("useTreeDnd must be used inside a TreeDndProvider");
    }
    return value;
}

export interface TreeDndProviderProps {
    /** The department's forest from `buildTree` — the provider derives the flat set itself. */
    roots: readonly TreeNode<TaskRowView>[];
    /** Ids whose children are currently shown; the sortable projection follows the visible rows. */
    expandedIds: ReadonlySet<number>;
    /**
     * Called with the moved row's id and the pinned `{ parent_id, sibling_ids }` payload when a drop
     * settles on a valid target. Never called for a no-op or a cycle. The id is part of the contract
     * because the move route is addressed by the moved node (`PATCH /tasks/<id>/move`) while the
     * payload describes its destination — including a new `parent_id` when the drag re-parented.
     */
    onMove?: (activeId: number, payload: MoveTaskInput) => void;
    /**
     * The department's COMPLETE flat row set — every root, across every page. It is used for the
     * cycle guard, the emitted `sibling_ids` and the anchor's position in the full child list, and
     * defaults to the rows under `roots`. Pagination is by root, so pass this whenever `roots` is a
     * page slice: the reorder contract is defined over the destination parent's complete child list,
     * and computing it from one page would omit the off-page siblings.
     */
    allRows?: readonly DndRow[];
    /** Disables every drag handle — todo 21 sets this while a filter or search is active. */
    reorderDisabled?: boolean;
    /** Overrides the dragged-row clone; defaults to a compact title + badges card. */
    renderOverlay?: (node: TreeNode<TaskRowView>) => ReactNode;
    children: ReactNode;
}

/** Pre-order walk over the WHOLE forest — collapsed rows stay in the cycle guard's view. */
function collectAllRows<T extends DndRow>(roots: readonly TreeNode<T>[]): TreeNode<T>[] {
    const collected: TreeNode<T>[] = [];
    const stack: TreeNode<T>[] = [...roots];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) continue;
        collected.push(node);
        for (const child of node.children) stack.push(child);
    }
    return collected;
}

function pointerFromActivator(activator: Event): { x: number; y: number } | null {
    if (!hasViewportRelativeCoordinates(activator)) return null;
    return { x: activator.clientX, y: activator.clientY };
}

/**
 * The single drag-and-drop wrapper for the task tree.
 *
 * Architecture (pinned and non-negotiable):
 * - ONE `DndContext` for the whole tree region.
 * - ONE `SortableContext` over the flattened projection of currently VISIBLE rows — never one per
 *   tree level. A collapsed subtree is excluded from `items` until it is expanded OR until a
 *   drag-dwell springs it open (see the transient expansion below).
 * - ONE droppable per row, and it is the sortable registered by `useSortable` inside
 *   `SortableTaskRow`. The provider deliberately registers no second droppable: a duplicate id
 *   collides in dnd-kit's container map and clobbers the measured rect.
 * - The drop INTENT is the whole hierarchy decision: the pointer's vertical third picks
 *   before / nest / after (`resolveDropIntent`), and the keyboard's Left/Right cycles the same ring
 *   (`cycleDropIntent`). There is no horizontal-offset depth channel.
 * - Resolution happens ONCE per move and is stored. The indicator, the overlay label and the drop
 *   all read the same `resolvedDepth` / payload, so what is previewed is exactly what a drop applies.
 * - The collision detector scopes candidates to `droppableTargetIds`, i.e. every row except the
 *   dragged node and its descendants, so `over` can never resolve onto a cycle target.
 *   `pointerWithin` is primary, `closestCenter` the row-gap fall-through.
 * - Dwell-spring: hovering a collapsed parent for `AUTO_EXPAND_DELAY_MS` expands it for the
 *   duration of the drag only. The expansion is derived into the rendered children, never written
 *   back to the tree's own expand state, and is dropped the moment the drag ends.
 * - `DragOverlay` renders the clone so the list does not reflow mid-drag.
 *
 * Data-injectable: `roots` / `expandedIds` / `onMove` are props, so the engine mounts with fixtures
 * and no API.
 */
export function TreeDndProvider({
    roots,
    expandedIds,
    onMove,
    allRows,
    reorderDisabled = false,
    renderOverlay,
    children,
}: TreeDndProviderProps) {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [activeId, setActiveId] = useState<number | null>(null);
    const [overId, setOverId] = useState<number | null>(null);
    const [intent, setIntent] = useState<DropIntent | null>(null);
    const [resolvedDepth, setResolvedDepth] = useState<number | null>(null);
    const [transientExpandedIds, setTransientExpandedIds] = useState<ReadonlySet<number>>(
        () => new Set<number>(),
    );

    const pageRows = useMemo(() => collectAllRows(roots), [roots]);
    const computationRows = useMemo<readonly DndRow[]>(
        () => allRows ?? pageRows,
        [allRows, pageRows],
    );

    /** The drag-scoped expansion is unioned over the caller's set; the caller's state is untouched. */
    const effectiveExpandedIds = useMemo<ReadonlySet<number>>(() => {
        if (transientExpandedIds.size === 0) return expandedIds;
        const merged = new Set(expandedIds);
        for (const id of transientExpandedIds) merged.add(id);
        return merged;
    }, [expandedIds, transientExpandedIds]);

    const visibleNodes = useMemo(
        () => flattenVisible(roots, effectiveExpandedIds),
        [roots, effectiveExpandedIds],
    );
    const visibleIds = useMemo(() => visibleNodes.map((node) => node.id), [visibleNodes]);
    const visibleRows = useMemo<readonly FlatRow[]>(
        () =>
            visibleNodes.map((node) => ({
                id: node.id,
                parent_id: node.parent_id,
                sort_order: node.sort_order,
                depth: node.depth,
            })),
        [visibleNodes],
    );
    const nodesById = useMemo(() => {
        const byId = new Map<number, TreeNode<TaskRowView>>();
        for (const node of pageRows) byId.set(node.id, node);
        return byId;
    }, [pageRows]);

    const pointerRef = useRef<{ x: number; y: number } | null>(null);
    const overRectRef = useRef<{ top: number; height: number } | null>(null);
    const overIdRef = useRef<number | null>(null);
    const intentRef = useRef<DropIntent | null>(null);
    const pendingPayloadRef = useRef<MovePayload | null>(null);
    const keyboardIntentRef = useRef<DropIntent>(KEYBOARD_START_INTENT);
    const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * Resolves the current over+intent ONCE and stores the result.
     *
     * `pendingPayloadRef` is the single source of truth a drop emits; `resolvedDepth` is the single
     * source the indicator/label renders. Recomputing at drop time would reintroduce the exact
     * preview/result divergence this replaces.
     */
    const resolveCurrent = useCallback(
        (active: number, over: number | null, nextIntent: DropIntent | null) => {
            if (over === null || over === active || nextIntent === null) {
                pendingPayloadRef.current = null;
                setResolvedDepth(null);
                return;
            }
            const resolved = resolveDropDestination({
                visibleRows,
                allRows: computationRows,
                activeId: active,
                overId: over,
                intent: nextIntent,
            });
            pendingPayloadRef.current = resolved === null ? null : resolved.payload;
            setResolvedDepth(resolved === null ? null : resolved.depth);
        },
        [visibleRows, computationRows],
    );

    const applyIntent = useCallback(
        (active: number, over: number | null, nextIntent: DropIntent | null) => {
            intentRef.current = nextIntent;
            setIntent(nextIntent);
            resolveCurrent(active, over, nextIntent);
        },
        [resolveCurrent],
    );

    /**
     * Left/Right cycle the drop intent (before → nest → after), Up/Down step the order.
     *
     * dnd-kit's keyboard sensor only understands coordinates, so Left/Right return the unchanged
     * coordinates to keep `over` put while the intent ring advances; Up/Down delegate to
     * `sortableKeyboardCoordinates`. Drop (Enter/Space) and cancel (Esc) stay the sensor's, and the
     * stored payload obeys the same neighbour clamp and cycle rules as the pointer's.
     */
    const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
        (event, args) => {
            if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
                event.preventDefault();
                const next = cycleDropIntent(
                    intentRef.current ?? KEYBOARD_START_INTENT,
                    event.code === "ArrowRight" ? 1 : -1,
                );
                keyboardIntentRef.current = next;
                applyIntent(Number(args.active), overIdRef.current, next);
                return args.currentCoordinates;
            }
            return sortableKeyboardCoordinates(event, args);
        },
        [applyIntent],
    );

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter }),
    );

    const collisionDetection = useCallback<CollisionDetection>(
        (args) => {
            // Cycle guard at the collision layer: the dragged node and its descendants can never be
            // `over`, so a re-parent that would loop is never previewable. Unlike the old
            // same-parent filter this does NOT restrict the destination level — re-parenting is the
            // whole point now; only the structural cycle is refused.
            const targets = droppableTargetIds(computationRows, Number(args.active.id));
            const scoped = {
                ...args,
                droppableContainers: args.droppableContainers.filter((container) =>
                    targets.has(Number(container.id)),
                ),
            };
            if (scoped.droppableContainers.length === 0) return [];

            const pointerCollisions = pointerWithin(scoped);
            return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(scoped);
        },
        [computationRows],
    );

    const clearTransientExpansion = useCallback(() => {
        if (expandTimerRef.current !== null) {
            clearTimeout(expandTimerRef.current);
            expandTimerRef.current = null;
        }
        setTransientExpandedIds((previous) => (previous.size === 0 ? previous : new Set<number>()));
    }, []);

    const clearDragState = useCallback(() => {
        pointerRef.current = null;
        overRectRef.current = null;
        overIdRef.current = null;
        intentRef.current = null;
        pendingPayloadRef.current = null;
        keyboardIntentRef.current = KEYBOARD_START_INTENT;
        clearTransientExpansion();
        setActiveId(null);
        setOverId(null);
        setIntent(null);
        setResolvedDepth(null);
    }, [clearTransientExpansion]);

    /**
     * Spring-loading: while a drag hovers a collapsed parent, start a one-shot timer; when it fires,
     * add the id to the drag-scoped transient set so its children render and become drop targets.
     * Any change of `over` (or of the drag) cancels the timer, so springing is deliberate, not
     * incidental. The caller's persistent `expandedIds` is never written.
     */
    useEffect(() => {
        if (expandTimerRef.current !== null) {
            clearTimeout(expandTimerRef.current);
            expandTimerRef.current = null;
        }
        if (activeId === null || overId === null) return;
        if (effectiveExpandedIds.has(overId)) return;
        const node = nodesById.get(overId);
        if (node === undefined || node.children.length === 0) return;

        expandTimerRef.current = setTimeout(() => {
            expandTimerRef.current = null;
            setTransientExpandedIds((previous) => {
                if (previous.has(overId)) return previous;
                const next = new Set(previous);
                next.add(overId);
                return next;
            });
        }, AUTO_EXPAND_DELAY_MS);

        return () => {
            if (expandTimerRef.current !== null) {
                clearTimeout(expandTimerRef.current);
                expandTimerRef.current = null;
            }
        };
    }, [activeId, overId, effectiveExpandedIds, nodesById]);

    const handleDragStart = (event: DragStartEvent) => {
        pointerRef.current = pointerFromActivator(event.activatorEvent);
        overRectRef.current = null;
        overIdRef.current = null;
        intentRef.current = null;
        pendingPayloadRef.current = null;
        keyboardIntentRef.current = KEYBOARD_START_INTENT;
        clearTransientExpansion();
        setActiveId(Number(event.active.id));
        setOverId(null);
        setIntent(null);
        setResolvedDepth(null);
    };

    const handleDragOver = (event: DragOverEvent) => {
        const active = Number(event.active.id);
        const over = event.over === null ? null : Number(event.over.id);
        const overChanged = over !== overIdRef.current;
        overIdRef.current = over;
        setOverId(over);

        if (over === null || over === active) {
            overRectRef.current = null;
            applyIntent(active, over, null);
            return;
        }

        const rect = event.over?.rect ?? null;
        overRectRef.current = rect === null ? null : { top: rect.top, height: rect.height };

        const pointer = pointerRef.current;
        if (pointer === null || rect === null) {
            // Keyboard drag: the intent is the ring's current value, not a pointer position.
            applyIntent(active, over, keyboardIntentRef.current);
            return;
        }

        applyIntent(
            active,
            over,
            resolveDropIntent({
                pointerY: pointer.y + event.delta.y,
                rectTop: rect.top,
                rectHeight: rect.height,
                // A fresh hover resolves on the plain thirds; within one row the previous intent
                // widens its own edge so a pointer on a boundary holds steady.
                previous: overChanged ? null : intentRef.current,
            }),
        );
    };

    const handleDragMove = (event: DragMoveEvent) => {
        // The pointer can change third within the SAME row without `over` changing, so the intent is
        // re-resolved on every move — that is what makes the indicator update live.
        const active = Number(event.active.id);
        const over = event.over === null ? overIdRef.current : Number(event.over.id);
        if (event.over !== null) {
            overRectRef.current = { top: event.over.rect.top, height: event.over.rect.height };
        }
        const pointer = pointerRef.current;
        const rect = overRectRef.current;

        if (pointer !== null && rect !== null && over !== null && over !== active) {
            applyIntent(
                active,
                over,
                resolveDropIntent({
                    pointerY: pointer.y + event.delta.y,
                    rectTop: rect.top,
                    rectHeight: rect.height,
                    previous: intentRef.current,
                }),
            );
            return;
        }
        resolveCurrent(active, over, intentRef.current);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const active = Number(event.active.id);
        // The payload resolved during the last move IS the drop — it is never re-derived here.
        const payload = pendingPayloadRef.current;

        clearDragState();

        if (reorderDisabled) return;
        if (payload === null) return;

        onMove?.(active, payload);
    };

    const contextValue = useMemo<TreeDndContextValue>(
        () => ({
            activeId,
            overId,
            intent,
            resolvedDepth,
            isReorderDisabled: reorderDisabled,
            rows: computationRows,
        }),
        [activeId, overId, intent, resolvedDepth, computationRows, reorderDisabled],
    );

    /**
     * The rendered children with the drag-scoped expansion folded in.
     *
     * A clone is the only way a wrapper can widen a child's `expandedIds` prop without editing the
     * child: the caller's element keeps its own props, and this override exists only while a
     * transient expansion is live (i.e. mid-drag), so the persistent state and its owners are intact.
     */
    const renderedChildren = useMemo<ReactNode>(() => {
        if (transientExpandedIds.size === 0) return children;
        if (!isValidElement<{ expandedIds?: ReadonlySet<number> }>(children)) return children;
        return cloneElement(children, { expandedIds: effectiveExpandedIds });
    }, [children, transientExpandedIds, effectiveExpandedIds]);

    const activeNode = activeId === null ? null : (nodesById.get(activeId) ?? null);

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={clearDragState}
        >
            <TreeDndContext.Provider value={contextValue}>
                <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
                    {renderedChildren}
                </SortableContext>
            </TreeDndContext.Provider>

            <DragOverlay
                dropAnimation={prefersReducedMotion ? null : undefined}
                modifiers={[restrictToVerticalAxis]}
            >
                {activeNode === null
                    ? null
                    : (renderOverlay?.(activeNode) ?? (
                          <TaskDragOverlay
                              node={activeNode}
                              intent={intent}
                              resolvedDepth={resolvedDepth}
                          />
                      ))}
            </DragOverlay>
        </DndContext>
    );
}

function TaskDragOverlay({
    node,
    intent,
    resolvedDepth,
}: {
    node: TreeNode<TaskRowView>;
    intent: DropIntent | null;
    resolvedDepth: number | null;
}) {
    return (
        <div
            data-slot="task-drag-overlay"
            className="flex max-w-[360px] items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-2 shadow-lg"
        >
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-sm font-medium">{node.title}</span>
            <TaskStatusBadge status={node.status} />
            <TaskPriorityBadge priority={node.priority} />
            {intent !== null && (
                <span
                    data-slot="task-drag-intent"
                    className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
                >
                    {INTENT_LABELS[intent]}
                    {resolvedDepth === null ? "" : ` · Level ${resolvedDepth + 1}`}
                </span>
            )}
        </div>
    );
}

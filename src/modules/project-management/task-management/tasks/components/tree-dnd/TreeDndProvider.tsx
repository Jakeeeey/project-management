"use client";

import {
    createContext,
    useCallback,
    useContext,
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
import { INDENT_STEP_PX, MAX_INDENT_DEPTH, type TaskRowView } from "../TaskRow";
import {
    droppableTargetIds,
    intentFromKeyboard,
    projectDepth,
    resolveDropIntent,
    resolveProjectedDrop,
    type DndRow,
    type DropIntent,
    type FlatRow,
} from "./dnd-logic";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

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
 * Used to drop the animated transform/drop transitions while KEEPING the drop indicator and the
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
    /** The depth the drop will actually apply, or `null` when the current over is not a valid drop. */
    readonly projectedDepth: number | null;
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
 *   tree level. A collapsed subtree is excluded from `items`, so it is not a drop target until it
 *   is expanded (dropping onto a row that is not rendered is explicitly out of scope).
 * - ONE droppable per row, and it is the sortable registered by `useSortable` inside
 *   `SortableTaskRow`. The provider deliberately registers no second droppable: a duplicate id
 *   collides in dnd-kit's container map and clobbers the measured rect.
 * - Vertical position is ORDER (`resolveDropIntent`), horizontal offset is DEPTH
 *   (`projectDepth` → `resolveProjectedDrop`). The collision detector scopes candidates to
 *   `droppableTargetIds`, i.e. every row except the dragged node and its descendants, so `over` can
 *   never resolve onto a cycle target. `pointerWithin` is primary, `closestCenter` the row-gap
 *   fall-through.
 * - The resolved depth is exposed on the context and rendered on the drag overlay, so the preview
 *   shows the indentation the drop will apply.
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
    const [projectedDepth, setProjectedDepth] = useState<number | null>(null);

    const pageRows = useMemo(() => collectAllRows(roots), [roots]);
    const computationRows = useMemo<readonly DndRow[]>(
        () => allRows ?? pageRows,
        [allRows, pageRows],
    );
    const visibleNodes = useMemo(() => flattenVisible(roots, expandedIds), [roots, expandedIds]);
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
    const deltaXRef = useRef(0);
    const keyboardDepthRef = useRef(0);

    const refreshProjection = useCallback(
        (active: number, over: number | null, nextIntent: DropIntent | null) => {
            if (over === null || over === active || nextIntent === null) {
                setProjectedDepth(null);
                return;
            }
            const sourceDepth = nodesById.get(active)?.depth ?? 0;
            const deltaX = pointerRef.current === null
                ? keyboardDepthRef.current * INDENT_STEP_PX
                : deltaXRef.current;
            const resolved = resolveProjectedDrop({
                visibleRows,
                allRows: computationRows,
                activeId: active,
                overId: over,
                intent: nextIntent,
                projectedDepth: projectDepth(sourceDepth, deltaX, INDENT_STEP_PX),
            });
            setProjectedDepth(resolved === null ? null : resolved.depth);
        },
        [nodesById, visibleRows, computationRows],
    );

    /**
     * Left/Right change the projected depth, Up/Down still step the order.
     *
     * The keyboard keeps its own depth offset (in steps) rather than pretending to move the pointer:
     * dnd-kit's sensor only understands coordinates, so returning the unchanged coordinates for
     * Left/Right keeps `over` put while `keyboardDepthRef` feeds the same `projectDepth` the pointer
     * uses. Up/Down delegate to `sortableKeyboardCoordinates`. Drop (Enter/Space) and cancel (Esc)
     * stay the sensor's, and the resolved payload obeys the same projection and cycle rules.
     */
    const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
        (event, args) => {
            if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
                event.preventDefault();
                keyboardDepthRef.current += event.code === "ArrowRight" ? 1 : -1;
                refreshProjection(Number(args.active), overIdRef.current, intentRef.current);
                return args.currentCoordinates;
            }
            return sortableKeyboardCoordinates(event, args);
        },
        [refreshProjection],
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

    const clearDragState = useCallback(() => {
        pointerRef.current = null;
        overRectRef.current = null;
        overIdRef.current = null;
        intentRef.current = null;
        deltaXRef.current = 0;
        keyboardDepthRef.current = 0;
        setActiveId(null);
        setOverId(null);
        setIntent(null);
        setProjectedDepth(null);
    }, []);

    const handleDragStart = (event: DragStartEvent) => {
        pointerRef.current = pointerFromActivator(event.activatorEvent);
        overRectRef.current = null;
        overIdRef.current = null;
        intentRef.current = null;
        deltaXRef.current = 0;
        keyboardDepthRef.current = 0;
        setActiveId(Number(event.active.id));
        setOverId(null);
        setIntent(null);
        setProjectedDepth(null);
    };

    const handleDragOver = (event: DragOverEvent) => {
        const active = Number(event.active.id);
        const over = event.over === null ? null : Number(event.over.id);
        overIdRef.current = over;
        setOverId(over);

        if (over === null || over === active) {
            overRectRef.current = null;
            intentRef.current = null;
            setIntent(null);
            setProjectedDepth(null);
            return;
        }

        const rect = event.over?.rect ?? null;
        overRectRef.current = rect === null ? null : { top: rect.top, height: rect.height };

        const pointer = pointerRef.current;
        const nextIntent =
            pointer === null || rect === null
                ? intentFromKeyboard(event.delta.y)
                : resolveDropIntent({
                      pointerY: pointer.y + event.delta.y,
                      rectTop: rect.top,
                      rectHeight: rect.height,
                  });

        intentRef.current = nextIntent;
        setIntent(nextIntent);
        refreshProjection(active, over, nextIntent);
    };

    const handleDragMove = (event: DragMoveEvent) => {
        // Horizontal travel changes the projected depth without changing `over`, so the depth is
        // recomputed on every move, not just when the hovered row changes.
        deltaXRef.current = event.delta.x;
        const active = Number(event.active.id);
        const over = event.over === null ? overIdRef.current : Number(event.over.id);
        refreshProjection(active, over, intentRef.current);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const active = Number(event.active.id);
        const over = event.over === null ? overIdRef.current : Number(event.over.id);
        const finalIntent = intentRef.current;
        const deltaX = pointerRef.current === null
            ? keyboardDepthRef.current * INDENT_STEP_PX
            : deltaXRef.current;

        clearDragState();

        if (reorderDisabled) return;
        if (over === null || finalIntent === null) return;

        const sourceDepth = nodesById.get(active)?.depth ?? 0;
        const resolved = resolveProjectedDrop({
            visibleRows,
            allRows: computationRows,
            activeId: active,
            overId: over,
            intent: finalIntent,
            projectedDepth: projectDepth(sourceDepth, deltaX, INDENT_STEP_PX),
        });
        if (resolved === null) return;

        onMove?.(active, resolved.payload);
    };

    const contextValue = useMemo<TreeDndContextValue>(
        () => ({
            activeId,
            overId,
            intent,
            projectedDepth,
            isReorderDisabled: reorderDisabled,
            rows: computationRows,
        }),
        [activeId, overId, intent, projectedDepth, computationRows, reorderDisabled],
    );

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
                    {children}
                </SortableContext>
            </TreeDndContext.Provider>

            <DragOverlay
                dropAnimation={prefersReducedMotion ? null : undefined}
                modifiers={[restrictToVerticalAxis]}
            >
                {activeNode === null
                    ? null
                    : (renderOverlay?.(activeNode) ?? (
                          <TaskDragOverlay node={activeNode} projectedDepth={projectedDepth} />
                      ))}
            </DragOverlay>
        </DndContext>
    );
}

function TaskDragOverlay({
    node,
    projectedDepth,
}: {
    node: TreeNode<TaskRowView>;
    projectedDepth: number | null;
}) {
    const visualDepth = Math.min(projectedDepth ?? node.depth, MAX_INDENT_DEPTH);

    return (
        <div
            data-slot="task-drag-overlay"
            // The indent is the live depth preview: it matches `min(projectedDepth, cap)` exactly the
            // way `TaskRow` renders rows, so the overlay shows the level the drop will apply.
            style={{ marginLeft: visualDepth * INDENT_STEP_PX }}
            className="flex max-w-[360px] items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-2 shadow-lg"
        >
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-sm font-medium">{node.title}</span>
            <TaskStatusBadge status={node.status} />
            <TaskPriorityBadge priority={node.priority} />
            {projectedDepth !== null && (
                <span className="shrink-0 text-xs text-muted-foreground">
                    Level {projectedDepth + 1}
                </span>
            )}
        </div>
    );
}

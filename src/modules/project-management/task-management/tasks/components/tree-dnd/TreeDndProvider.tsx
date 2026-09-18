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
    type DragOverEvent,
    type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { hasViewportRelativeCoordinates } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import { flattenVisible, isDescendant, type TreeNode } from "../../utils/tree";
import { type MoveTaskInput } from "@/modules/project-management/task-management/tasks/types/pm-task.schema";

import { TaskPriorityBadge, TaskStatusBadge } from "../TaskRowBadges";
import { type TaskRowView } from "../TaskRow";
import {
    intentFromKeyboard,
    resolveDropIntent,
    resolveDropPayload,
    type DndRow,
    type DropIntent,
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
    /** True when `overId` is inside the dragged row's subtree — the nest affordance is suppressed. */
    readonly isOverDescendant: boolean;
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
     * settles on a valid target. Never called for a no-op, and never called for a cycle. The id is
     * part of the contract because the move route is addressed by the moved node
     * (`PATCH /tasks/<id>/move`) while the payload describes its destination.
     */
    onMove?: (activeId: number, payload: MoveTaskInput) => void;
    /**
     * The department's COMPLETE flat row set — every root, across every page. It is used only for
     * the cycle guard and for the emitted `sibling_ids`, and defaults to the rows under `roots`.
     * Pagination is by root, so pass this whenever `roots` is a page slice: the reorder contract is
     * defined over the destination parent's complete child list, and computing it from one page
     * would omit the off-page siblings and make the move route reject every root move.
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
 * - Drop intent is the pointer's vertical third inside the `over` rect, resolved by
 *   `resolveDropIntent`. `pointerWithin` is the primary collision detector, `closestCenter` the
 *   fall-through for the gaps between rows.
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

    const pageRows = useMemo(() => collectAllRows(roots), [roots]);
    const computationRows = useMemo<readonly DndRow[]>(
        () => allRows ?? pageRows,
        [allRows, pageRows],
    );
    const visibleIds = useMemo(
        () => flattenVisible(roots, expandedIds).map((node) => node.id),
        [roots, expandedIds],
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

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const collisionDetection = useCallback<CollisionDetection>((args) => {
        const pointerCollisions = pointerWithin(args);
        return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
    }, []);

    const clearDragState = useCallback(() => {
        pointerRef.current = null;
        overRectRef.current = null;
        overIdRef.current = null;
        intentRef.current = null;
        setActiveId(null);
        setOverId(null);
        setIntent(null);
    }, []);

    const handleDragStart = (event: DragStartEvent) => {
        pointerRef.current = pointerFromActivator(event.activatorEvent);
        overRectRef.current = null;
        overIdRef.current = null;
        intentRef.current = null;
        setActiveId(Number(event.active.id));
        setOverId(null);
        setIntent(null);
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
            return;
        }

        const overIsDescendant = isDescendant(computationRows, active, over);
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
                      overIsDescendant,
                  });

        intentRef.current = nextIntent;
        setIntent(nextIntent);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const active = Number(event.active.id);
        const over = event.over === null ? overIdRef.current : Number(event.over.id);
        const finalIntent = intentRef.current;

        clearDragState();

        if (reorderDisabled) return;
        if (over === null || finalIntent === null) return;

        const payload = resolveDropPayload(computationRows, active, over, finalIntent);
        if (payload === null) return;

        onMove?.(active, payload);
    };

    const contextValue = useMemo<TreeDndContextValue>(
        () => ({
            activeId,
            overId,
            intent,
            isOverDescendant:
                activeId !== null && overId !== null && isDescendant(computationRows, activeId, overId),
            isReorderDisabled: reorderDisabled,
            rows: computationRows,
        }),
        [activeId, overId, intent, computationRows, reorderDisabled],
    );

    const activeNode = activeId === null ? null : (nodesById.get(activeId) ?? null);

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
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
                    : (renderOverlay?.(activeNode) ?? <TaskDragOverlay node={activeNode} />)}
            </DragOverlay>
        </DndContext>
    );
}

function TaskDragOverlay({ node }: { node: TreeNode<TaskRowView> }) {
    return (
        <div
            data-slot="task-drag-overlay"
            className="flex max-w-[360px] items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-2 shadow-lg"
        >
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-sm font-medium">{node.title}</span>
            <TaskStatusBadge status={node.status} />
            <TaskPriorityBadge priority={node.priority} />
        </div>
    );
}

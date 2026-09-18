/**
 * Pure geometry and destination logic for the task tree's drag-and-drop engine.
 *
 * Everything dnd-kit-aware lives in `TreeDndProvider`; this file holds only the decisions that can
 * be reasoned about without a DOM — the three-zone drop intent, the destination parent, the
 * neighbour clamp, which rows are legal targets, and the `{ parent_id, sibling_ids }` payload a drop
 * resolves to. Keeping it separate is what makes the engine fixture-assertable:
 * `tree-dnd/__assert.ts` feeds it the same calls the provider's handlers make.
 *
 * MODEL: the drop INTENT carries the hierarchy decision. The pointer's vertical position inside the
 * hovered row picks one of three zones — top third = insert BEFORE, middle third = become CHILD
 * (nest), bottom third = insert AFTER — with a small hysteresis band so the intent does not flicker
 * at a zone edge. There is no horizontal-offset depth channel: "into vs between" IS the depth choice.
 *
 * A before/after drop reorders among the hovered row's siblings (its destination parent is the
 * hovered row's own parent); a nest drop re-parents the dragged row under the hovered row. Depth is
 * clamped by NEIGHBOURS — `minDepth = nextItem.depth`, `maxDepth = previousItem.depth + 1`, parent
 * derived from the row above the gap — never by the hovered row's ancestry. Neighbours are read from
 * the LIVE visible list (the dragged row is left in place), because the rendered list does not
 * reflow mid-drag: that is the list the indicator is drawn against, and reading it is what keeps a
 * shown indicator from resolving to no payload. The only structural rule left is the CYCLE GUARD:
 * the dragged node and every descendant of it are never legal targets.
 *
 * This file imports nothing and uses only erasable syntax (no `enum`, no `namespace`, no parameter
 * properties) so `__assert.ts` can load it through Node's native type stripping.
 */

/** The minimum row shape the engine needs; a full `TaskRowView` satisfies it structurally. */
export interface DndRow {
    readonly id: number;
    readonly parent_id: number | null;
    readonly sort_order: number;
}

/**
 * A row carrying its TRUE computed depth, as `flattenVisible` returns it (see `utils/tree.ts`).
 *
 * Depth is structural and is never capped here — the visual indent cap is presentation only, so a
 * level-12 row keeps `depth: 12` and only renders flush with level 8.
 */
export interface FlatRow extends DndRow {
    readonly depth: number;
}

/** Where a drop lands relative to the row under the pointer: above it, inside it, or below it. */
export type DropIntent = "before" | "nest" | "after";

/** The pinned reorder/re-parent write contract: the destination parent plus its ordered child list. */
export interface MovePayload {
    parent_id: number | null;
    sibling_ids: number[];
}

/**
 * The three zones, as fractions of the hovered row's height. The middle third is the nest zone; the
 * two outer thirds are the sibling-insert zones. `INTENT_HYSTERESIS` widens a zone's edge while that
 * zone is already active, so a pointer resting on a boundary cannot alternate between two intents.
 */
export const NEST_ZONE_START = 1 / 3;
export const NEST_ZONE_END = 2 / 3;
export const INTENT_HYSTERESIS = 0.08;

/** The cycle Right/Left steps through: top zone, middle zone, bottom zone, wrapping. */
const INTENT_CYCLE: readonly DropIntent[] = ["before", "nest", "after"];

/** Sibling order is `(sort_order, id)` — the order every read path returns and a write must match. */
function bySortOrder(a: DndRow, b: DndRow): number {
    return a.sort_order - b.sort_order || a.id - b.id;
}

/** The current parent of `id`, or `null` when the row is a root or absent from the set. */
function parentOf(rows: readonly DndRow[], id: number): number | null {
    const row = rows.find((candidate) => candidate.id === id);
    return row === undefined ? null : row.parent_id;
}

/**
 * Answers the cycle guard: would making `parentId` the parent of `activeId` close a loop?
 *
 * `isDescendant` in `utils/tree.ts` is deliberately strict (`isDescendant(x, x) === false`), so the
 * self-parent case is rejected explicitly here rather than relied on to fall out of the walk.
 * Cycle-safe: a loop in the data terminates instead of hanging.
 */
export function isCycleTarget(rows: readonly DndRow[], activeId: number, parentId: number | null): boolean {
    if (parentId === null) return false;
    if (parentId === activeId) return true;

    const seen = new Set<number>();
    let cursor = rows.find((row) => row.id === parentId);
    while (cursor !== undefined && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        const { parent_id: nextParentId } = cursor;
        if (nextParentId === null) return false;
        if (nextParentId === activeId) return true;
        cursor = rows.find((row) => row.id === nextParentId);
    }
    return false;
}

/**
 * The destination parent's ordered live child ids with the moved node removed.
 *
 * The subtraction matters: before the write the moved node is not yet a child of the target parent,
 * so a caller that wants the post-move list must splice it back in — which is exactly the
 * membership rule the move route applies. Passing `excludeId` here keeps that logic in one place.
 */
export function listChildIds(
    rows: readonly DndRow[],
    parentId: number | null,
    excludeId?: number,
): number[] {
    return rows
        .filter((row) => row.parent_id === parentId && row.id !== excludeId)
        .sort(bySortOrder)
        .map((row) => row.id);
}

/**
 * Splices the moved id into the destination parent's child list and returns the pinned payload.
 *
 * The cycle guard is the one structural refusal: `parentId` may not be the moved node or any of its
 * descendants. Every other parent is legal, including a different level (re-parent) and `null`
 * (promote to root). `insertIndex` is clamped so a stale index can never drop a sibling.
 */
export function computeMovePayload(
    rows: readonly DndRow[],
    activeId: number,
    parentId: number | null,
    insertIndex: number,
): MovePayload | null {
    if (isCycleTarget(rows, activeId, parentId)) return null;

    const children = listChildIds(rows, parentId, activeId);
    const index = Math.max(0, Math.min(insertIndex, children.length));
    const siblingIds = [...children.slice(0, index), activeId, ...children.slice(index)];
    return { parent_id: parentId, sibling_ids: siblingIds };
}

/** Inputs for the three-zone decision. `rectHeight === 0` (unmeasured) falls back to insert-after. */
export interface DropIntentInput {
    readonly pointerY: number;
    readonly rectTop: number;
    readonly rectHeight: number;
    /**
     * The intent currently shown. Its zone keeps its edge widened by `INTENT_HYSTERESIS`, so a
     * pointer hovering a boundary holds one intent instead of oscillating. `null` (a fresh hover)
     * resolves on the plain thirds.
     */
    readonly previous?: DropIntent | null;
}

/**
 * Resolves the drop intent from which third of the `over` rect the pointer is in.
 *
 * Boundaries: a pointer at exactly one third reads as nest (the middle zone owns its lower edge) and
 * at exactly two thirds reads as after (the lower zone owns its edge). An unmeasured rect defaults
 * to insert-after — an unknown target must not silently nest.
 */
export function resolveDropIntent(input: DropIntentInput): DropIntent {
    const { pointerY, rectTop, rectHeight, previous = null } = input;

    if (rectHeight <= 0) return "after";

    const ratio = (pointerY - rectTop) / rectHeight;

    const lowerEdge =
        previous === "before"
            ? NEST_ZONE_START + INTENT_HYSTERESIS
            : previous === "nest"
              ? NEST_ZONE_START - INTENT_HYSTERESIS
              : NEST_ZONE_START;
    const upperEdge =
        previous === "after"
            ? NEST_ZONE_END - INTENT_HYSTERESIS
            : previous === "nest"
              ? NEST_ZONE_END + INTENT_HYSTERESIS
              : NEST_ZONE_END;

    if (ratio < lowerEdge) return "before";
    if (ratio < upperEdge) return "nest";
    return "after";
}

/**
 * Steps the intent around the three-zone ring: `before → nest → after → before`.
 *
 * The ring follows the row's geometry (top, middle, bottom, wrapping), so Right always moves the
 * intent downward through the drop zones and Left moves it upward. This is the keyboard's whole
 * depth decision now: Left/Right choose between "between" and "into" instead of nudging an offset.
 */
export function cycleDropIntent(current: DropIntent, direction: 1 | -1): DropIntent {
    const index = INTENT_CYCLE.indexOf(current);
    const next = (index + direction + INTENT_CYCLE.length) % INTENT_CYCLE.length;
    return INTENT_CYCLE[next];
}

/** Inputs for resolving a concrete drop destination. */
export interface DropDestinationInput {
    /** Visible rows in render order, carrying true depth. */
    readonly visibleRows: readonly FlatRow[];
    /** The complete flat row set — used for sibling lists and the cycle guard. */
    readonly allRows: readonly DndRow[];
    readonly activeId: number;
    readonly overId: number;
    readonly intent: DropIntent;
}

/** A valid drop: the depth that will be applied, its parent, and the payload that applies it. */
export interface DropDestination {
    readonly depth: number;
    readonly parentId: number | null;
    readonly payload: MovePayload;
}

/**
 * Resolves the hovered row and intent into the destination parent, depth and payload.
 *
 * - `nest` targets the hovered row itself and appends the moved node as its last child.
 * - `before`/`after` target the gap above/below the hovered row; the desired depth is the hovered
 *   row's own level, then CLAMPED BY NEIGHBOURS: `minDepth = nextItem.depth` (the row below the gap
 *   can never end up beneath the moved node) and `maxDepth = previousItem.depth + 1` (the row above
 *   caps how deep the gap can be). The parent is the nearest row above the gap at `depth - 1`, so a
 *   bottom-third drop on an expanded parent lands as its first child, and a top-level gap yields
 *   `parent_id: null`.
 *
 * The hovered row's ancestry is never consulted. The cycle guard is the only refusal: a drop onto
 * the dragged node or any descendant returns `null`.
 */
export function resolveDropDestination(input: DropDestinationInput): DropDestination | null {
    const { visibleRows, allRows, activeId, overId, intent } = input;

    if (overId === activeId) return null;
    if (isCycleTarget(allRows, activeId, overId)) return null;

    const overIndex = visibleRows.findIndex((row) => row.id === overId);
    if (overIndex === -1) return null;
    const overDepth = visibleRows[overIndex].depth;

    if (intent === "nest") {
        const children = listChildIds(allRows, overId, activeId);
        return {
            depth: overDepth + 1,
            parentId: overId,
            payload: { parent_id: overId, sibling_ids: [...children, activeId] },
        };
    }

    // The gap is the boundary the indicator is drawn on, read from the list the user is looking at.
    // The dragged row is deliberately NOT removed: the rendered list does not reflow mid-drag, so
    // removing it here would compute neighbours (and sometimes a missing parent) that the indicator
    // never showed — the exact preview/result divergence this resolver exists to eliminate.
    const gap = intent === "before" ? overIndex : overIndex + 1;
    const previousItem = gap > 0 ? visibleRows[gap - 1] : undefined;
    const nextItem = gap < visibleRows.length ? visibleRows[gap] : undefined;

    const minDepth = nextItem === undefined ? 0 : nextItem.depth;
    const maxDepth = previousItem === undefined ? 0 : previousItem.depth + 1;
    const depth = Math.max(minDepth, Math.min(overDepth, maxDepth));

    let parentId: number | null = null;
    if (depth > 0) {
        for (let index = gap - 1; index >= 0; index -= 1) {
            if (visibleRows[index].depth === depth - 1) {
                parentId = visibleRows[index].id;
                break;
            }
        }
        if (parentId === null) return null;
        if (isCycleTarget(allRows, activeId, parentId)) return null;
    }

    // Anchor on the destination parent's last child above the gap, so splicing after it puts the
    // moved node exactly where the insertion line is drawn.
    const children = listChildIds(allRows, parentId, activeId);
    let insertIndex = 0;
    for (let index = gap - 1; index >= 0; index -= 1) {
        const row = visibleRows[index];
        if (parentOf(allRows, row.id) !== parentId) continue;
        const position = children.indexOf(row.id);
        if (position !== -1) {
            insertIndex = position + 1;
            break;
        }
    }

    const payload = computeMovePayload(allRows, activeId, parentId, insertIndex);
    if (payload === null) return null;
    return { depth, parentId, payload };
}

/**
 * Every row a drag may legally target: all rows except the dragged node and its descendants.
 *
 * `TreeDndProvider` scopes its collision candidates to this set so `over` can never resolve onto a
 * cycle target. The dragged row itself is excluded too, so a drop is never a self-drop.
 */
export function droppableTargetIds(rows: readonly DndRow[], activeId: number): Set<number> {
    const ids = new Set<number>();
    for (const row of rows) {
        if (row.id === activeId) continue;
        if (isCycleTarget(rows, activeId, row.id)) continue;
        ids.add(row.id);
    }
    return ids;
}

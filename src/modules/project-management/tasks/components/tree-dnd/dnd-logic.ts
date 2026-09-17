/**
 * Pure drop-intent and move-payload logic for the task tree's drag-and-drop engine.
 *
 * Everything dnd-kit-aware lives in `TreeDndProvider`; this file holds only the decisions that can
 * be reasoned about without a DOM — which vertical third of the row the pointer is in, and what the
 * pinned `{ parent_id, sibling_ids }` payload becomes once a drop settles. Keeping it separate is
 * what makes the engine fixture-assertable: `tree-dnd/__assert.ts` feeds it the same calls the
 * provider's `onDragOver` / `onDragEnd` handlers make.
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

/** Where a drop lands relative to the row under the pointer. */
export type DropIntent = "before" | "after" | "nest";

/** The pinned reorder write contract: the destination parent plus its complete ordered child list. */
export interface MovePayload {
    parent_id: number | null;
    sibling_ids: number[];
}

/**
 * Vertical thirds of the `over` rect. Top third inserts before the row, bottom third inserts after
 * it, and the middle third nests as a child — unless the row is a descendant of the dragged node,
 * in which case the middle third degrades to an insert (a nest would be a cycle).
 */
export const BEFORE_FRACTION = 1 / 3;
export const AFTER_FRACTION = 2 / 3;

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
 * `insertIndex` is clamped into range so a stale index can never drop a sibling. Returns `null`
 * when the destination is the moved node itself or one of its descendants, and the caller then
 * emits nothing — the client-side half of the cycle refusal (the move route is the other half).
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

/** Inputs for the pointer-third decision. `rectHeight === 0` (unmeasured) falls back to nesting. */
export interface DropIntentInput {
    readonly pointerY: number;
    readonly rectTop: number;
    readonly rectHeight: number;
    /** True when the `over` row sits inside the dragged row's subtree — no nest affordance then. */
    readonly overIsDescendant: boolean;
}

/**
 * Pointer-driven intent from the pointer's vertical third inside the `over` rect.
 *
 * A descendant of the dragged row must not offer the nest affordance, so its middle third returns
 * an insert intent instead. The resulting payload is still refused by `computeMovePayload` (the
 * destination parent would be inside the dragged subtree), so the cycle never reaches the wire.
 */
export function resolveDropIntent(input: DropIntentInput): DropIntent {
    const { pointerY, rectTop, rectHeight, overIsDescendant } = input;

    if (rectHeight <= 0) return overIsDescendant ? "before" : "nest";

    const ratio = (pointerY - rectTop) / rectHeight;
    if (ratio < BEFORE_FRACTION) return "before";
    if (ratio > AFTER_FRACTION) return "after";
    return overIsDescendant ? "before" : "nest";
}

/**
 * Keyboard reorder is sibling-only: the drag direction decides before/after and never nests.
 *
 * Re-parenting for keyboard users is the separate "Move to…" dialog, which emits the same payload —
 * `sortableKeyboardCoordinates` is deliberately never asked to change a row's parent.
 */
export function intentFromKeyboard(deltaY: number): DropIntent {
    return deltaY < 0 ? "before" : "after";
}

/**
 * Maps a settled drop onto the pinned payload, or `null` when nothing should be emitted.
 *
 * `before` / `after` resolve the destination parent from the `over` row's parent; `nest` makes the
 * `over` row itself the parent. All three delegate to `computeMovePayload`, so the cycle guard and
 * the complete-child-list contract hold for every entry point.
 */
export function resolveDropPayload(
    rows: readonly DndRow[],
    activeId: number,
    overId: number,
    intent: DropIntent,
): MovePayload | null {
    if (overId === activeId) return null;

    if (intent === "nest") {
        return computeMovePayload(rows, activeId, overId, Number.MAX_SAFE_INTEGER);
    }

    const parentId = parentOf(rows, overId);
    const siblings = listChildIds(rows, parentId, activeId);
    const overIndex = siblings.indexOf(overId);
    if (overIndex === -1) return null;

    return computeMovePayload(rows, activeId, parentId, intent === "before" ? overIndex : overIndex + 1);
}

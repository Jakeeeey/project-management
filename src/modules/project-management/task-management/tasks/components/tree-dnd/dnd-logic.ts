/**
 * Pure geometry and destination logic for the task tree's drag-and-drop engine.
 *
 * Everything dnd-kit-aware lives in `TreeDndProvider`; this file holds only the decisions that can
 * be reasoned about without a DOM — the vertical before/after intent, the horizontal depth
 * projection, which rows are legal targets, and the `{ parent_id, sibling_ids }` payload a drop
 * resolves to. Keeping it separate is what makes the engine fixture-assertable:
 * `tree-dnd/__assert.ts` feeds it the same calls the provider's handlers make.
 *
 * MODEL: vertical position sets ORDER, horizontal offset sets DEPTH (Notion/Workflowy style).
 * `projectDepth` turns the horizontal offset into a candidate level and `resolveProjectedDrop`
 * validates that level against the hovered row's real ancestry before composing the move.
 * Re-parenting is the point, so the only structural rule left is the CYCLE GUARD: the dragged node
 * and every descendant of it are never legal targets.
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

/** Where a drop lands relative to the row under the pointer. Vertical only; depth is separate. */
export type DropIntent = "before" | "after";

/** The pinned reorder/re-parent write contract: the destination parent plus its ordered child list. */
export interface MovePayload {
    parent_id: number | null;
    sibling_ids: number[];
}

/**
 * The pointer's vertical midpoint splits insert-before from insert-after.
 *
 * Depth (horizontal) never affects this: a plain vertical drag keeps the source's depth, so the
 * accidental case remains a same-level reorder.
 */
export const INSERT_MIDPOINT = 0.5;

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

/** Inputs for the pointer-half decision. `rectHeight === 0` (unmeasured) falls back to insert-after. */
export interface DropIntentInput {
    readonly pointerY: number;
    readonly rectTop: number;
    readonly rectHeight: number;
}

/**
 * Insert-before or insert-after, from which vertical half of the `over` rect the pointer is in.
 *
 * Depth is not decided here — that is the horizontal projection's job.
 */
export function resolveDropIntent(input: DropIntentInput): DropIntent {
    const { pointerY, rectTop, rectHeight } = input;

    if (rectHeight <= 0) return "after";

    const ratio = (pointerY - rectTop) / rectHeight;
    return ratio < INSERT_MIDPOINT ? "before" : "after";
}

/** Keyboard vertical reorder is the same before/after decision as the pointer's vertical half. */
export function intentFromKeyboard(deltaY: number): DropIntent {
    return deltaY < 0 ? "before" : "after";
}

/**
 * Horizontal drag offset → projected depth: one step per `indentStepPx` of travel.
 *
 * `sourceDepth` is the dragged row's TRUE depth, and no upper clamp is applied here. `MAX_INDENT_DEPTH`
 * is a VISUAL cap (`TaskRow` renders `min(depth, cap)` while `aria-level` keeps the true value), so
 * using it as a structural ceiling would silently promote every over-cap row on the first right
 * drag and forbid nesting it deeper. The real ceiling is the hovered row's own depth + 1, enforced
 * by `resolveProjectedDrop`; a plain vertical drag (`deltaX === 0`) reproduces the source depth.
 */
export function projectDepth(sourceDepth: number, deltaX: number, indentStepPx: number): number {
    if (indentStepPx <= 0) return Math.max(0, sourceDepth);
    const steps = Math.round(deltaX / indentStepPx);
    return Math.max(0, sourceDepth + steps);
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

/** The id of the nearest row above the drop boundary at exactly `depth`, or `undefined`. */
function lastRowAboveWithDepth(
    visibleRows: readonly FlatRow[],
    boundary: number,
    depth: number,
): number | undefined {
    for (let index = boundary - 1; index >= 0; index -= 1) {
        if (visibleRows[index].depth === depth) return visibleRows[index].id;
    }
    return undefined;
}

export interface ProjectedDropInput {
    /** Visible rows in render order, carrying true depth. */
    readonly visibleRows: readonly FlatRow[];
    /** The complete flat row set — used for sibling lists and the cycle guard. */
    readonly allRows: readonly DndRow[];
    readonly activeId: number;
    readonly overId: number;
    readonly intent: DropIntent;
    /** Candidate depth from `projectDepth`, before ancestry validation. */
    readonly projectedDepth: number;
}

/** A valid drop: the depth that will actually be applied plus the payload that applies it. */
export interface ProjectedDrop {
    readonly depth: number;
    readonly payload: MovePayload;
}

/**
 * Validates a projected depth against the hovered row and composes the move.
 *
 * The hovered row's ancestry makes every level `0..overDepth` legitimate, plus `overDepth + 1` to
 * become that row's child; `projectedDepth` is clamped into that range and then walked downward
 * until a real parent row exists at `depth - 1` (e.g. "before" the first child has no previous
 * sibling to nest under, so it falls back to the child's own level). `depth === 0` is the root and
 * is a legitimate destination.
 *
 * The destination parent is the nearest row above the boundary at `depth - 1`; the insert index is
 * placed immediately after that parent's last child above the boundary, so the moved node lands
 * where the gap is previewed. Returns `null` for a self-drop, a drop over a descendant (cycle), or
 * an inconsistent row set.
 */
export function resolveProjectedDrop(input: ProjectedDropInput): ProjectedDrop | null {
    const { visibleRows, allRows, activeId, overId, intent, projectedDepth } = input;

    if (overId === activeId) return null;
    if (isCycleTarget(allRows, activeId, overId)) return null;

    const overIndex = visibleRows.findIndex((row) => row.id === overId);
    if (overIndex === -1) return null;

    const overDepth = visibleRows[overIndex].depth;
    const boundary = overIndex + (intent === "after" ? 1 : 0);
    const ceiling = overDepth + 1;

    let depth = Math.max(0, Math.min(projectedDepth, ceiling));
    let parentId: number | null = null;
    while (depth > 0) {
        const candidate = lastRowAboveWithDepth(visibleRows, boundary, depth - 1);
        const candidateIsSafe =
            candidate !== undefined &&
            candidate !== activeId &&
            !isCycleTarget(allRows, activeId, candidate);
        if (candidateIsSafe) {
            parentId = candidate;
            break;
        }
        depth -= 1;
    }

    const children = listChildIds(allRows, parentId, activeId);
    let anchorId: number | undefined;
    for (let index = boundary - 1; index >= 0; index -= 1) {
        const row = visibleRows[index];
        if (row.id !== activeId && parentOf(allRows, row.id) === parentId) {
            anchorId = row.id;
            break;
        }
    }

    let insertIndex = 0;
    if (anchorId !== undefined) {
        const position = children.indexOf(anchorId);
        if (position === -1) return null;
        insertIndex = position + 1;
    }

    const payload = computeMovePayload(allRows, activeId, parentId, insertIndex);
    if (payload === null) return null;
    return { depth, payload };
}

/**
 * The pure core of the move route's completeness rule — the one decision that is easy to get wrong.
 *
 * The reorder contract sends the destination parent's COMPLETE ordered child list after the move and
 * the route renumbers every entry by its array index. Without the completeness check a partial list
 * leaves the unlisted siblings holding stale `sort_order` values, which can duplicate an index and
 * make the read-back order disagree with what was sent.
 *
 * Membership is the trap this file exists to name: **before the write the moved node is not yet a
 * child of the target parent** — it is still under its old parent, or is a root. A bare
 * "is this id a child of the target parent" test therefore rejects the moved node itself and fails
 * every valid move, including every pure reorder. The moved id is treated as a member here, on top
 * of whatever the current rows say.
 *
 * This file imports nothing and uses only erasable syntax (no `enum`, no `namespace`, no parameter
 * properties) so `./__assert.ts` can load it through Node's native type stripping.
 */

/** The minimum row shape these rules need; a live `pm_task` row satisfies it structurally. */
export interface MoveChildRow {
    readonly id: number;
    readonly parent_id: number | null;
}

/** "Does the ordered list name `id` exactly once?" An absent or repeated moved node is refused. */
export function containsExactlyOnce(ids: readonly number[], id: number): boolean {
    let count = 0;
    for (const candidate of ids) {
        if (candidate === id) count += 1;
    }
    return count === 1;
}

/**
 * "Is `siblingIds` exactly the target parent's complete post-move live child set?"
 *
 * Computed as *(the target parent's current live children, minus the moved node if it was already
 * among them) **plus** the moved node*: every row whose `parent_id` is the target counts, except the
 * moved node itself, which is added back unconditionally. The order of `siblingIds` is deliberately
 * not checked — the array's order IS the order to write (each entry's index becomes its
 * `sort_order`), while completeness is a set question.
 *
 * @param rows       The department's live rows (`id`, `parent_id`).
 * @param movedId    The task being moved — added to the target's child set per the membership rule.
 * @param parentId   The destination parent; `null` means "root".
 * @param siblingIds The complete ordered child list the client computed after the move.
 */
export function isCompletePostMoveChildSet(
    rows: readonly MoveChildRow[],
    movedId: number,
    parentId: number | null,
    siblingIds: readonly number[],
): boolean {
    const targetChildIds = new Set<number>();
    for (const row of rows) {
        if (row.id !== movedId && row.parent_id === parentId) targetChildIds.add(row.id);
    }
    targetChildIds.add(movedId);

    if (siblingIds.length !== targetChildIds.size) return false;

    const seen = new Set<number>();
    for (const id of siblingIds) {
        if (seen.has(id) || !targetChildIds.has(id)) return false;
        seen.add(id);
    }
    return true;
}

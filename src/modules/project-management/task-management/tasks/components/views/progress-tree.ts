import type { TreeSourceRow, TreeNode } from "../../utils/tree";

/**
 * Which rows survive a search or a filter, and how the forest is cut down to them.
 *
 * Pure and React-free. One rule lives here: a row stays on screen when it MATCHES, or when it is an
 * ANCESTOR of a match. A match does not drag its subtree along — hiding a parent's unrelated
 * children is the point of a filter. That is why this cannot reuse `pruneForest`, which keeps a
 * matching node's whole subtree.
 */

/**
 * The matched ids plus every ancestor of each. Walks up and stops on the first id it has already
 * kept, so a cycle in `parent_id` terminates instead of spinning.
 */
export function visibleTaskIds(
    rows: readonly { readonly id: number; readonly parent_id: number | null }[],
    matchedIds: ReadonlySet<number>,
): Set<number> {
    const parentById = new Map<number, number | null>();
    for (const row of rows) parentById.set(row.id, row.parent_id);

    const visible = new Set<number>();
    for (const id of matchedIds) {
        let cursor: number | null | undefined = id;
        while (cursor !== null && cursor !== undefined && !visible.has(cursor)) {
            visible.add(cursor);
            cursor = parentById.get(cursor) ?? null;
        }
    }
    return visible;
}

/**
 * The forest cut down to the ids that stay on screen.
 *
 * Each kept node is a shallow copy carrying its pruned children, so `depth` and every other field
 * survive and the grid's `aria-level` still announces true depth. Nothing is re-parented:
 * a kept child keeps its own parent, because a node is kept only when its parent was kept too.
 */
export function pruneToVisible<T extends TreeSourceRow>(
    nodes: readonly TreeNode<T>[],
    visible: ReadonlySet<number>,
): TreeNode<T>[] {
    const kept: TreeNode<T>[] = [];
    for (const node of nodes) {
        if (!visible.has(node.id)) continue;
        kept.push({ ...node, children: pruneToVisible(node.children, visible) });
    }
    return kept;
}

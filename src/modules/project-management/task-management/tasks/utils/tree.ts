/**
 * Adjacency-list tree helpers for `pm_task`.
 *
 * The hierarchy is stored as a self-referencing `parent_id`; there is no `depth` column, because a
 * stored level drifts the moment a subtree is re-parented. Level is computed here, during assembly,
 * and the cascade delete replays the same structure leaf-first.
 *
 * Every helper is total: an orphan (`parent_id` naming a row that is not in the set) becomes a
 * root and a parent cycle is broken by promoting one of its rows, so a malformed row can never be
 * dropped or crash a render.
 *
 * This file imports nothing and uses only erasable syntax (no `enum`, no `namespace`, no parameter
 * properties) so `utils/__assert.ts` can load it through Node's native type stripping.
 */

/** The minimum row shape these helpers need; a full task row satisfies it structurally. */
export interface TreeSourceRow {
    readonly id: number;
    readonly parent_id: number | null;
    readonly sort_order: number;
}

/** A row enriched during assembly. `depth` is computed here, never stored in the database. */
export type TreeNode<T extends TreeSourceRow> = T & {
    depth: number;
    children: TreeNode<T>[];
};

/** Sibling order is `(sort_order, id)` — the order every read path is expected to return. */
function sortSiblings<T extends TreeSourceRow>(nodes: TreeNode<T>[]): void {
    nodes.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

function indexById<T extends TreeSourceRow>(rows: readonly T[]): Map<number, T> {
    const byId = new Map<number, T>();
    for (const row of rows) byId.set(row.id, row);
    return byId;
}

/**
 * Assembles flat rows into a forest, ordered by `(sort_order, id)` at every level.
 *
 * Tolerant by design: a row whose parent is missing from the set is returned as a root, and a row
 * trapped in a parent cycle is promoted and detached from its parent. The tasks page renders
 * exactly what this returns, so silently dropping a row here would hide work.
 *
 * @param rows The department's live rows. Every row is expected to be present, but subsetting is
 *             safe — a parent outside the set simply yields a root.
 * @returns Root nodes, depth 0, each carrying its ordered descendants.
 */
export function buildTree<T extends TreeSourceRow>(rows: readonly T[]): TreeNode<T>[] {
    const nodes = new Map<number, TreeNode<T>>();
    for (const row of rows) nodes.set(row.id, { ...row, depth: 0, children: [] });

    const roots: TreeNode<T>[] = [];
    for (const node of nodes.values()) {
        const parent = node.parent_id === null ? undefined : nodes.get(node.parent_id);
        if (parent === undefined || parent === node) roots.push(node);
        else parent.children.push(node);
    }
    for (const node of nodes.values()) sortSiblings(node.children);

    const visited = new Set<number>();
    const place = (start: TreeNode<T>): void => {
        const queue: TreeNode<T>[] = [start];
        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const node = queue[cursor];
            if (visited.has(node.id)) continue;
            visited.add(node.id);
            for (const child of node.children) {
                child.depth = node.depth + 1;
                queue.push(child);
            }
        }
    };
    for (const root of roots) {
        root.depth = 0;
        place(root);
    }

    // A parent cycle has no root to hang from. Promote each row still unplaced and detach it from
    // its parent so it renders exactly once; `place` always marks its argument, so this terminates.
    for (const node of nodes.values()) {
        if (visited.has(node.id)) continue;
        const parent = node.parent_id === null ? undefined : nodes.get(node.parent_id);
        if (parent !== undefined) parent.children = parent.children.filter((child) => child !== node);
        node.depth = 0;
        roots.push(node);
        place(node);
    }

    sortSiblings(roots);
    return roots;
}

/**
 * Computes a row's level by walking `parent_id` upwards. Cycle-safe and orphan-safe: a parent that
 * is missing, or a row that names itself, terminates the walk at the current level.
 *
 * @param rows The same flat set the tree would be built from.
 * @param id   The row to measure. An id not present in `rows` reports depth 0.
 * @returns 0 for a root, 1 for its child, and so on.
 */
export function computeDepth(rows: readonly TreeSourceRow[], id: number): number {
    const byId = indexById(rows);
    const seen = new Set<number>();
    let cursor = byId.get(id);
    let depth = 0;
    while (cursor !== undefined && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        const parent = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id);
        if (parent === undefined || parent.id === cursor.id) break;
        depth += 1;
        cursor = parent;
    }
    return depth;
}

/**
 * Answers the re-parenting cycle guard: is `nodeId` strictly below `ancestorId`?
 *
 * A node is NOT its own descendant, so a caller rejecting a cycle must also reject the
 * self-parent case (`ancestorId === nodeId`) explicitly. Cycle-safe: a loop in the data reports
 * `false` instead of hanging.
 *
 * @param rows       The flat set to search.
 * @param ancestorId The candidate ancestor (the moved task in a re-parent).
 * @param nodeId     The candidate descendant (the target parent in a re-parent).
 */
export function isDescendant(
    rows: readonly TreeSourceRow[],
    ancestorId: number,
    nodeId: number,
): boolean {
    if (ancestorId === nodeId) return false;
    const byId = indexById(rows);
    const seen = new Set<number>();
    let cursor = byId.get(nodeId);
    while (cursor !== undefined && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        if (cursor.parent_id === null) return false;
        if (cursor.parent_id === ancestorId) return true;
        cursor = byId.get(cursor.parent_id);
    }
    return false;
}

/**
 * Collects every descendant of `id`, deepest level first.
 *
 * The cascade delete walks this in order so a mid-flight failure can only hide rows beneath a
 * still-visible parent, never leave a live child orphaned under a deleted one. The node itself is
 * not included — the caller soft-deletes the subject row separately.
 *
 * @param rows The flat set to search.
 * @param id   The subtree root.
 * @returns Descendant ids, deepest level first (to delete leaves before branches).
 */
export function collectDescendantIds(rows: readonly TreeSourceRow[], id: number): number[] {
    const byParent = new Map<number, number[]>();
    for (const row of rows) {
        if (row.parent_id === null) continue;
        const children = byParent.get(row.parent_id);
        if (children === undefined) byParent.set(row.parent_id, [row.id]);
        else children.push(row.id);
    }

    const levels: number[][] = [];
    const seen = new Set<number>([id]);
    let frontier = byParent.get(id) ?? [];
    while (frontier.length > 0) {
        const level: number[] = [];
        const next: number[] = [];
        for (const childId of frontier) {
            if (seen.has(childId)) continue;
            seen.add(childId);
            level.push(childId);
            const grandchildren = byParent.get(childId);
            if (grandchildren !== undefined) next.push(...grandchildren);
        }
        if (level.length > 0) levels.push(level);
        frontier = next;
    }

    const deepestFirst: number[] = [];
    for (let index = levels.length - 1; index >= 0; index -= 1) deepestFirst.push(...levels[index]);
    return deepestFirst;
}

/**
 * Projects a forest onto the rows the screen should show: every root, plus the children of any
 * node whose id is in `expandedIds`.
 *
 * Iterative pre-order, so an arbitrarily deep tree cannot overflow the call stack. The returned
 * nodes are the same objects `buildTree` produced, so their `depth` is the true computed level
 * (the visual indent cap is presentation only and must not feed `aria-level`).
 *
 * @param roots       The forest from `buildTree`.
 * @param expandedIds Ids whose children are currently expanded.
 * @returns Visible nodes in render order.
 */
export function flattenVisible<T extends TreeSourceRow>(
    roots: readonly TreeNode<T>[],
    expandedIds: ReadonlySet<number>,
): TreeNode<T>[] {
    const visible: TreeNode<T>[] = [];
    const stack: TreeNode<T>[] = [];
    for (let index = roots.length - 1; index >= 0; index -= 1) stack.push(roots[index]);
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) continue;
        visible.push(node);
        if (!expandedIds.has(node.id)) continue;
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            stack.push(node.children[index]);
        }
    }
    return visible;
}

/** A copy of `node` and every descendant, so a pruned forest can never alias the source forest. */
function cloneSubtree<T extends TreeSourceRow>(node: TreeNode<T>): TreeNode<T> {
    return { ...node, children: node.children.map(cloneSubtree) };
}

/**
 * Prunes a forest to the branches that satisfy `isMatch`.
 *
 * The rule is applied recursively and is deliberately asymmetric:
 * - a node that MATCHES keeps its ENTIRE subtree — nothing beneath a match is pruned. This is what
 *   lets a user search for a parent and then expand it to work with its real children: the subtask
 *   count stays the parent's true count and the chevron opens onto rows, not onto nothing;
 * - a node that does NOT match is kept only while a descendant matches, and only on the branches
 *   that lead to (or contain) a match — so a deep match is never orphaned by a missing ancestor;
 * - anything else is dropped, so a search that matches nothing returns an empty forest.
 *
 * Returned nodes are copies (the source forest is untouched) and keep their `depth`, so a kept
 * row's visual indent and `aria-level` do not shift when sibling branches are pruned away.
 *
 * @param nodes   The forest to prune, typically from `buildTree`.
 * @param isMatch The row-level predicate; a match is kept together with its whole subtree.
 * @returns The pruned forest, preserving the source order at every level.
 */
export function pruneForest<T extends TreeSourceRow>(
    nodes: readonly TreeNode<T>[],
    isMatch: (row: T) => boolean,
): TreeNode<T>[] {
    const kept: TreeNode<T>[] = [];
    for (const node of nodes) {
        if (isMatch(node)) {
            kept.push(cloneSubtree(node));
            continue;
        }
        const children = pruneForest(node.children, isMatch);
        if (children.length > 0) kept.push({ ...node, children });
    }
    return kept;
}

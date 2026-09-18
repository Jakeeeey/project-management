/**
 * Assertion harness for the tree helpers' pure logic: assembly (`buildTree`), projection
 * (`flattenVisible`) and the search/filter pruning rule (`pruneForest`).
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/task-management/tasks/utils/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * Why the `.ts` extension and the directive: Node resolves a relative import only when the specifier
 * carries the real file extension, while `tsc` rejects a `.ts` specifier unless
 * `allowImportingTsExtensions` is on — and the project `tsconfig.json` (a protected scaffold file
 * this module may not edit) does not enable it. The directive suppresses only that extension
 * complaint; the module is still fully resolved and typed by `tsc`.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { buildTree, flattenVisible, pruneForest, type TreeNode, type TreeSourceRow } from "./tree.ts";

interface FixtureRow extends TreeSourceRow {
    readonly title: string;
}

const SOURCE: FixtureRow[] = [
    { id: 1, parent_id: null, sort_order: 0, title: "Roadmap" },
    { id: 2, parent_id: 1, sort_order: 0, title: "Design" },
    { id: 3, parent_id: 1, sort_order: 1, title: "Build" },
    { id: 4, parent_id: 3, sort_order: 0, title: "Deploy" },
    { id: 5, parent_id: null, sort_order: 1, title: "Budget" },
    { id: 6, parent_id: 5, sort_order: 0, title: "Invoices" },
    { id: 7, parent_id: null, sort_order: 2, title: "Misc" },
];

/** 20 (d0) -> 21 (d1) -> 22 (d2) -> 23 (d3) -> 24 (d4), one branch per level. */
const DEEP: FixtureRow[] = [
    { id: 20, parent_id: null, sort_order: 0, title: "L0" },
    { id: 21, parent_id: 20, sort_order: 0, title: "L1" },
    { id: 22, parent_id: 21, sort_order: 0, title: "L2" },
    { id: 23, parent_id: 22, sort_order: 0, title: "L3" },
    { id: 24, parent_id: 23, sort_order: 0, title: "L4" },
];

/** 30 (d0) -> 31 (d1) -> 32 (d2) -> 33 (d3): a match under a match, then non-matches. */
const NESTED: FixtureRow[] = [
    { id: 30, parent_id: null, sort_order: 0, title: "Outer" },
    { id: 31, parent_id: 30, sort_order: 0, title: "Inner" },
    { id: 32, parent_id: 31, sort_order: 0, title: "Leaf A" },
    { id: 33, parent_id: 32, sort_order: 0, title: "Leaf B" },
];

let checks = 0;
let failures = 0;

function check(label: string, passed: boolean, detail: string = ""): void {
    checks += 1;
    const suffix = detail === "" ? "" : ` (${detail})`;
    if (passed) {
        console.log(`ok   - ${label}${suffix}`);
        return;
    }
    failures += 1;
    console.error(`FAIL - ${label}${suffix}`);
}

function sameIds(actual: readonly number[], expected: readonly number[]): boolean {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

function matchByIds(ids: readonly number[]): (row: FixtureRow) => boolean {
    const set = new Set(ids);
    return (row) => set.has(row.id);
}

function findNode(
    nodes: readonly TreeNode<FixtureRow>[],
    id: number,
): TreeNode<FixtureRow> | undefined {
    for (const node of nodes) {
        if (node.id === id) return node;
        const found = findNode(node.children, id);
        if (found !== undefined) return found;
    }
    return undefined;
}

function requireNode(nodes: readonly TreeNode<FixtureRow>[], id: number): TreeNode<FixtureRow> {
    const node = findNode(nodes, id);
    if (node === undefined) throw new Error(`fixture node ${id} is missing from the pruned forest`);
    return node;
}

function rootIds(nodes: readonly TreeNode<FixtureRow>[]): number[] {
    return nodes.map((node) => node.id);
}

function childIds(node: TreeNode<FixtureRow>): number[] {
    return node.children.map((child) => child.id);
}

function allIds(nodes: readonly TreeNode<FixtureRow>[]): number[] {
    const ids: number[] = [];
    const stack = [...nodes];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) continue;
        ids.push(node.id);
        stack.push(...node.children);
    }
    return ids;
}

const roots = buildTree(SOURCE);

// --- A matching row keeps its ENTIRE subtree --------------------------------------------------------

const matchedRoot = pruneForest(roots, matchByIds([1]));
check("a matching root is kept", rootIds(matchedRoot).includes(1));
check("no non-matching root survives alongside it", sameIds(rootIds(matchedRoot), [1]));
check(
    "a matching parent keeps ALL of its non-matching children",
    sameIds(childIds(requireNode(matchedRoot, 1)), [2, 3]),
);
check(
    "…and the non-matching grandchild under a non-matching child",
    sameIds(childIds(requireNode(matchedRoot, 3)), [4]),
);
check("the deepest row beneath a match is still present", findNode(matchedRoot, 4) !== undefined);

// --- A matching leaf is unchanged -------------------------------------------------------------------

const matchedLeaf = pruneForest(roots, matchByIds([4]));
check("a matching leaf is kept", findNode(matchedLeaf, 4) !== undefined);
check("a matching leaf has no children", childIds(requireNode(matchedLeaf, 4)).length === 0);
check(
    "a matching leaf's own row data is carried over unchanged",
    requireNode(matchedLeaf, 4).title === "Deploy" && requireNode(matchedLeaf, 4).depth === 2,
);
check(
    "the leaf's ancestor path survives with only the matching branch",
    sameIds(childIds(requireNode(matchedLeaf, 1)), [3]) && childIds(requireNode(matchedLeaf, 3)).length === 1,
);
check("a non-matching sibling branch is dropped", findNode(matchedLeaf, 2) === undefined);

// --- A non-matching ancestor keeps only the matching branches --------------------------------------

const matchedDeep = pruneForest(roots, matchByIds([6]));
check("a non-matching root with a matching descendant is kept", sameIds(rootIds(matchedDeep), [5]));
check(
    "…with only the matching branch beneath it",
    sameIds(childIds(requireNode(matchedDeep, 5)), [6]),
);
check(
    "unrelated roots are dropped",
    findNode(matchedDeep, 1) === undefined && findNode(matchedDeep, 7) === undefined,
);

const twoBranches = pruneForest(roots, matchByIds([2, 4]));
check(
    "a non-matching ancestor keeps every branch that reaches a match",
    sameIds(rootIds(twoBranches), [1]) &&
        sameIds(childIds(requireNode(twoBranches, 1)), [2, 3]) &&
        sameIds(childIds(requireNode(twoBranches, 3)), [4]),
);
check("a non-matching subtree with no match anywhere is dropped", findNode(twoBranches, 5) === undefined);

// --- A deep match's full ancestor path survives -----------------------------------------------------

const deepRoots = buildTree(DEEP);
const deepMatch = pruneForest(deepRoots, matchByIds([24]));
check(
    "every ancestor of a deep match survives",
    [20, 21, 22, 23, 24].every((id) => findNode(deepMatch, id) !== undefined),
);
check(
    "each kept ancestor carries exactly one child on the path",
    sameIds(childIds(requireNode(deepMatch, 20)), [21]) &&
        sameIds(childIds(requireNode(deepMatch, 21)), [22]) &&
        sameIds(childIds(requireNode(deepMatch, 22)), [23]) &&
        sameIds(childIds(requireNode(deepMatch, 23)), [24]),
);
check("the matched deep node's depth is preserved", requireNode(deepMatch, 24).depth === 4);

// --- A match nested under a match keeps its subtree -------------------------------------------------

const nestedRoots = buildTree(NESTED);
const nestedMatch = pruneForest(nestedRoots, matchByIds([30, 31]));
check(
    "a match nested under a match is kept",
    findNode(nestedMatch, 30) !== undefined && findNode(nestedMatch, 31) !== undefined,
);
check(
    "the nested match keeps its own subtree",
    sameIds(childIds(requireNode(nestedMatch, 31)), [32]) &&
        sameIds(childIds(requireNode(nestedMatch, 32)), [33]),
);
check("the nested match's non-matching descendants are retained", findNode(nestedMatch, 33) !== undefined);

// --- No match yields an empty forest ----------------------------------------------------------------

check("a search that matches nothing yields an empty forest", pruneForest(roots, matchByIds([])).length === 0);
check("an empty source yields an empty forest", pruneForest([], matchByIds([1])).length === 0);

// --- The count/children invariant: the number shown is the number revealed ---------------------------

const pathPruned = pruneForest(roots, matchByIds([2]));
const pathRoot = requireNode(pathPruned, 1);
check(
    "an ancestor-path row's count equals its kept children, not the source's",
    pathRoot.children.length === 1 && childIds(pathRoot).length === 1,
);
check(
    "expanding every kept row reveals exactly the kept rows (no phantom child, none hidden)",
    (() => {
        const everyKeptId = new Set(allIds(matchedRoot));
        return flattenVisible(matchedRoot, everyKeptId).length === everyKeptId.size;
    })(),
);
check(
    "a matched parent's count equals the children it retains",
    requireNode(matchedRoot, 1).children.length === 2,
);

// --- Copies and source isolation --------------------------------------------------------------------

const sourceChildCountBefore = requireNode(roots, 1).children.length;
const isolated = pruneForest(roots, matchByIds([4]));
check(
    "pruning leaves the source forest untouched",
    requireNode(roots, 1).children.length === sourceChildCountBefore &&
        findNode(roots, 2) !== undefined &&
        findNode(roots, 4) !== undefined,
);
check("kept nodes are copies, not the source nodes", findNode(isolated, 4) !== findNode(roots, 4));
const isolatedLeaf = findNode(isolated, 4);
const sourceLeaf = findNode(roots, 4);
check(
    "a copied node keeps its depth",
    isolatedLeaf !== undefined && sourceLeaf !== undefined && isolatedLeaf.depth === sourceLeaf.depth,
);

// --- Root order is preserved ------------------------------------------------------------------------

const multiRoot = pruneForest(roots, matchByIds([1, 5, 7]));
check("pruning preserves the source root order", sameIds(rootIds(multiRoot), [1, 5, 7]));

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

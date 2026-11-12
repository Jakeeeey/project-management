/**
 * Assertion harness for the tree helpers' pure logic: assembly (`buildTree`), projection
 * (`flattenVisible`) and the search/filter pruning rule (`pruneForest`) — plus the completion
 * rollup behind the Progress view (`./completion`).
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/task-management/tasks/utils/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * Why the `.ts` extensions and the `@ts-expect-error` directives: Node resolves a relative import
 * only when the specifier carries the real file extension, while `tsc` rejects a `.ts` specifier
 * unless `allowImportingTsExtensions` is on — and the project `tsconfig.json` (a protected scaffold
 * file this module may not edit) does not enable it. The directives suppress only that extension
 * complaint; the modules are still fully resolved and typed by `tsc`.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { buildTree, flattenVisible, pruneForest, type TreeNode, type TreeSourceRow } from "./tree.ts";
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { columnWeightScore, completionFlag, computeCompletion, describeCompletionPercent, formatCompletionPercent, statusCompletionScore, type CompletionAnswer, type CompletionRow } from "./completion.ts";

// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { buildOffsets, windowFor } from "../components/views/window.ts";

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

// --- Search: a hit stays, its ancestors stay, nothing else does -------------------------------------

const matchedRoot = pruneForest(roots, { matchesSearch: matchByIds([1]) });
check("a search hit is kept", rootIds(matchedRoot).includes(1));
check("no non-matching root survives alongside it", sameIds(rootIds(matchedRoot), [1]));
check(
    "a hit does NOT drag its non-matching descendants along",
    childIds(requireNode(matchedRoot, 1)).length === 0,
);

// --- A matching leaf is unchanged -------------------------------------------------------------------

const matchedLeaf = pruneForest(roots, { matchesSearch: matchByIds([4]) });
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

const matchedDeep = pruneForest(roots, { matchesSearch: matchByIds([6]) });
check("a non-matching root with a matching descendant is kept", sameIds(rootIds(matchedDeep), [5]));
check(
    "…with only the matching branch beneath it",
    sameIds(childIds(requireNode(matchedDeep, 5)), [6]),
);
check(
    "unrelated roots are dropped",
    findNode(matchedDeep, 1) === undefined && findNode(matchedDeep, 7) === undefined,
);

const twoBranches = pruneForest(roots, { matchesSearch: matchByIds([2, 4]) });
check(
    "a non-matching ancestor keeps every branch that reaches a match",
    sameIds(rootIds(twoBranches), [1]) &&
        sameIds(childIds(requireNode(twoBranches, 1)), [2, 3]) &&
        sameIds(childIds(requireNode(twoBranches, 3)), [4]),
);
check("a non-matching subtree with no match anywhere is dropped", findNode(twoBranches, 5) === undefined);

// --- A deep match's full ancestor path survives -----------------------------------------------------

const deepRoots = buildTree(DEEP);
const deepMatch = pruneForest(deepRoots, { matchesSearch: matchByIds([24]) });
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

// --- A match nested under a match keeps only what matches -------------------------------------------

const nestedRoots = buildTree(NESTED);
const nestedMatch = pruneForest(nestedRoots, { matchesSearch: matchByIds([30, 31]) });
check(
    "a match nested under a match is kept",
    findNode(nestedMatch, 30) !== undefined && findNode(nestedMatch, 31) !== undefined,
);
check(
    "the nested match keeps only its matching descendants",
    sameIds(childIds(requireNode(nestedMatch, 31)), []) && findNode(nestedMatch, 32) === undefined,
);

// --- No match yields an empty forest ----------------------------------------------------------------

check("a search that matches nothing yields an empty forest", pruneForest(roots, { matchesSearch: matchByIds([]) }).length === 0);
check("an empty source yields an empty forest", pruneForest([], { matchesSearch: matchByIds([1]) }).length === 0);

// --- Clauses select DOWN, exclusions cascade DOWN -----------------------------------------------
// The bug this replaced twice: `Tags is not X` hid the tagged parent but left the tagless children,
// which pass the clause on their own; and then `Status is X` hid a match's children, which are its
// contents rather than separate rows wanting a filter.

const excludedMid = pruneForest(roots, { failsExcludingClause: (row) => row.id === 3 });
check(
    "an excluded mid-branch row is dropped together with its descendants",
    findNode(excludedMid, 3) === undefined && findNode(excludedMid, 4) === undefined,
);
check(
    "its passing siblings and unrelated roots still render",
    sameIds(childIds(requireNode(excludedMid, 1)), [2]) && sameIds(rootIds(excludedMid), [1, 5, 7]),
);
check(
    "an excluded root drops its whole subtree",
    pruneForest(roots, { failsExcludingClause: (row) => row.id === 1 }).every((node) => node.id !== 1) &&
        findNode(pruneForest(roots, { failsExcludingClause: (row) => row.id === 1 }), 2) === undefined,
);
check(
    "an exclusion hides only its own branch, never a sibling's children",
    findNode(pruneForest(roots, { failsExcludingClause: (row) => row.id === 4 }), 3) !== undefined,
);

// The positive direction: a match is a selection, so its subtree comes with it.
const matchedBranch = pruneForest(roots, { passesClauses: (row) => row.id === 3 });
check(
    "a matched row keeps its children even when they do not match",
    sameIds(childIds(requireNode(matchedBranch, 3)), [4]),
);
check(
    "a matched row keeps its ancestors as context",
    findNode(matchedBranch, 1) !== undefined,
);
check(
    "rows outside the match and its ancestor path are dropped",
    findNode(matchedBranch, 2) === undefined && findNode(matchedBranch, 5) === undefined,
);
check(
    "a matched root keeps every level beneath it",
    (() => {
        const kept = pruneForest(roots, { passesClauses: (row) => row.id === 1 });
        return findNode(kept, 2) !== undefined && findNode(kept, 3) !== undefined && findNode(kept, 4) !== undefined;
    })(),
);

// --- Both rules: the clause set runs first, so a search hit cannot rescue a hidden branch -----------

const hiddenMatch = pruneForest(roots, {
    failsExcludingClause: (row) => row.id === 1,
    matchesSearch: matchByIds([2]),
});
check(
    "a search hit under an excluded parent does NOT surface",
    hiddenMatch.length === 0,
);
check(
    "an excluded ancestor does not block an unrelated sibling branch",
    sameIds(rootIds(pruneForest(roots, { failsExcludingClause: (row) => row.id === 1, matchesSearch: matchByIds([6]) })), [5]),
);
check(
    "search still reveals the ancestors of a hit when no clause hides them",
    [1, 3, 4].every((id) => findNode(pruneForest(roots, { passesClauses: () => true, matchesSearch: matchByIds([4]) }), id) !== undefined),
);

// --- The count/children invariant: the number shown is the number revealed ---------------------------

const pathPruned = pruneForest(roots, { matchesSearch: matchByIds([2]) });
const pathRoot = requireNode(pathPruned, 1);
check(
    "an ancestor-path row's count equals its kept children, not the source's",
    pathRoot.children.length === 1 && childIds(pathRoot).length === 1,
);
check(
    "expanding every kept row reveals exactly the kept rows (no phantom child, none hidden)",
    (() => {
        const everyKeptId = new Set(allIds(matchedLeaf));
        return flattenVisible(matchedLeaf, everyKeptId).length === everyKeptId.size;
    })(),
);
check(
    "a matched parent's count equals the children it retains",
    requireNode(matchedRoot, 1).children.length === 0,
);

// --- Copies and source isolation --------------------------------------------------------------------

const sourceChildCountBefore = requireNode(roots, 1).children.length;
const isolated = pruneForest(roots, { matchesSearch: matchByIds([4]) });
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

const multiRoot = pruneForest(roots, { matchesSearch: matchByIds([1, 5, 7]) });
check("pruning preserves the source root order", sameIds(rootIds(multiRoot), [1, 5, 7]));

// --- Completion rollup: fixtures ---------------------------------------------------------------------

function near(actual: number | undefined, expected: number, tolerance: number = 1e-9): boolean {
    return actual !== undefined && Math.abs(actual - expected) <= tolerance;
}

/** A row with no custom answers, for the status-based fixtures. */
function row(id: number, parentId: number | null, statusId: number): CompletionRow {
    return { id, parent_id: parentId, status_id: statusId, custom_values: [] };
}

/** A status catalog: id -> completion percent. `9` is deliberately absent (an unknown status). */
const statusPercents = new Map<number, number>([
    [1, 100],
    [2, 0],
    [3, 50],
]);
const byStatus = statusCompletionScore(statusPercents);

// --- The worked example -----------------------------------------------------------------------------
// 1 (parent) -> 2, 3, 4, 5 at 100 / 100 / 0 / 0. The parent is 50, not 50.0-something else.
const fourChildren: CompletionRow[] = [
    row(1, null, 2),
    row(2, 1, 1),
    row(3, 1, 1),
    row(4, 1, 2),
    row(5, 1, 2),
];
const flat = computeCompletion(fourChildren, byStatus);
check("four children at 100/100/0/0 give their parent 50", near(flat.valueById.get(1), 50));
check("the parent's own status (0) is ignored for its number", near(flat.ownById.get(1), 0));
check("the parent counts its four direct children", flat.childCountById.get(1) === 4);
check("a leaf keeps its own status percent exactly", near(flat.valueById.get(2), 100));
check("a zero-status leaf is 0", near(flat.valueById.get(4), 0));

// The level above: siblings 50 and 0 give 25 — the mean is taken level by level, not over leaves.
const nested: CompletionRow[] = [
    row(10, null, 2),
    row(11, 10, 2),
    row(12, 11, 1),
    row(13, 11, 1),
    row(14, 11, 2),
    row(15, 11, 2),
    row(16, 10, 2),
];
const rolled = computeCompletion(nested, byStatus);
check("the inner parent is 50", near(rolled.valueById.get(11), 50));
check("siblings 50 and 0 give their parent 25", near(rolled.valueById.get(10), 25));
check("the outer parent counts two children, not five leaves", rolled.childCountById.get(10) === 2);

// Equal weight per child regardless of how many leaves hang under one: 100 against 0 is 50,
// not the 66.7 a leaf-weighted average would give.
const uneven: CompletionRow[] = [
    row(20, null, 2),
    row(21, 20, 2),
    row(22, 21, 1),
    row(23, 21, 1),
    row(24, 20, 2),
];
check(
    "a branch with two leaves does not outvote a single-leaf sibling",
    near(computeCompletion(uneven, byStatus).valueById.get(20), 50),
);

// --- Flooring and the under-one band ----------------------------------------------------------------
// 100 + 100 + 99 + 99 + 100 = 498, over 5 = 99.6. It must print 99%, never a false 100%.
const almostDone: CompletionRow[] = [
    row(30, null, 2),
    row(31, 30, 1),
    row(32, 30, 1),
    row(33, 30, 4),
    row(34, 30, 4),
    row(35, 30, 1),
];
const withNinetyNine = new Map<number, number>([
    [1, 100],
    [4, 99],
]);
const nearly = computeCompletion(almostDone, statusCompletionScore(withNinetyNine));
check("the raw mean keeps its fraction (99.6)", near(nearly.valueById.get(30), 99.6));
check("99.6 prints 99%, not 100%", formatCompletionPercent(nearly.valueById.get(30) ?? 0) === "99%");
check("99.6 is announced as 99 percent", describeCompletionPercent(99.6) === "99 percent");

check("a mean of exactly 100 prints 100%", formatCompletionPercent(100) === "100%");
check("a mean of 0.5 prints <1%", formatCompletionPercent(0.5) === "<1%");
check("a mean of 0 prints 0%", formatCompletionPercent(0) === "0%");
check("a mean of 1 prints 1%", formatCompletionPercent(1) === "1%");
check("62 prints 62%", formatCompletionPercent(62) === "62%");
check("a negative value prints 0%", formatCompletionPercent(-3) === "0%");
check("0.5 is announced as less than 1 percent", describeCompletionPercent(0.5) === "less than 1 percent");
check("0 is announced as 0 percent", describeCompletionPercent(0) === "0 percent");

// A mean strictly between 0 and 1 really can be produced by the rollup: one child at 1, one at 0.
const sliver: CompletionRow[] = [row(40, null, 2), row(41, 40, 5), row(42, 40, 2)];
const onePercent = new Map<number, number>([[5, 1]]);
const sliverRollup = computeCompletion(sliver, statusCompletionScore(onePercent));
check("a mean of 0.5 survives the rollup unfloored", near(sliverRollup.valueById.get(40), 0.5));
check(
    "the 0.5 mean prints <1%",
    formatCompletionPercent(sliverRollup.valueById.get(40) ?? 0) === "<1%",
);

// --- Unknown status and missing answers -------------------------------------------------------------
const unknownStatus: CompletionRow[] = [row(50, null, 9)];
check(
    "a leaf whose status is not in the catalog scores 0, not NaN",
    computeCompletion(unknownStatus, byStatus).valueById.get(50) === 0,
);
check("an absent status percent reads as 0", byStatus(unknownStatus[0]) === 0);

// --- A parent cycle ----------------------------------------------------------------------------------
// 60 -> 61 -> 60, with 62 hanging off 60. No root exists, so the rollup must promote a cycle row
// instead of recursing forever. It must promote the same edge `buildTree` detaches: 61 renders as a
// LEAF under 60, so the back edge it names is not a child of anything and must be left out of the
// mean. Both walks take the first still-unplaced row in array order, which is why 60 is promoted.
const cycle: CompletionRow[] = [row(60, 61, 2), row(61, 60, 1), row(62, 60, 2)];
const cycleRollup = computeCompletion(cycle, byStatus);
check("a parent cycle still produces a value for every row", cycleRollup.valueById.size === 3);
check(
    "the cut row is a leaf at its own score, not an ancestor's, with no child counted",
    near(cycleRollup.valueById.get(61), 100) && cycleRollup.childCountById.get(61) === 0,
);
check(
    "the ancestor's mean covers only the children that render (100 and 0 give 50)",
    near(cycleRollup.valueById.get(60), 50) && cycleRollup.childCountById.get(60) === 2,
);
check(
    "the cut row carries no flag, because a row with no subtasks never does",
    completionFlag(
        cycleRollup.ownById.get(61) ?? 0,
        cycleRollup.valueById.get(61) ?? 0,
        cycleRollup.childCountById.get(61) ?? 0,
    ) === null,
);
check(
    "a self-parented row is a root and keeps its own score",
    computeCompletion([row(70, 70, 1)], byStatus).valueById.get(70) === 100,
);
check(
    "an orphan is a root, not a child of a missing parent",
    computeCompletion([row(80, 999, 1)], byStatus).valueById.get(80) === 100,
);

// --- Flags -------------------------------------------------------------------------------------------
check(
    "own 100 with a rollup of 50 flags 'marked complete, subtasks unfinished'",
    completionFlag(100, 50, 2) === "complete-with-unfinished-subtasks",
);
check(
    "a rollup of 100 with an own score of 0 flags the reverse disagreement",
    completionFlag(0, 100, 2) === "subtasks-complete-not-marked",
);
check("agreement carries no flag", completionFlag(100, 100, 2) === null);
check("a leaf never carries a flag", completionFlag(100, 100, 0) === null);
check("own 50 with a rollup of 50 carries no flag", completionFlag(50, 50, 3) === null);

// --- Weighted answers in a Choice column --------------------------------------------------------------
const answer = (fieldId: number, value: string | null): CompletionAnswer => ({
    field_id: fieldId,
    value,
});
/** Option id -> the percentage carrying it counts as. `9` is a real option weighted at zero. */
const optionWeights = new Map<string, number>([
    ["7", 100],
    ["8", 50],
    ["9", 0],
]);
const weightScore = columnWeightScore(3, optionWeights);
const answerRow = (value: string | null): CompletionRow => ({
    id: 1,
    parent_id: null,
    status_id: 1,
    custom_values: [answer(3, value)],
});
check(
    "a leaf carrying an option weighted 100 scores 100",
    weightScore(answerRow("7")) === 100,
);
check(
    "a leaf carrying an option weighted 50 scores 50, not 100",
    weightScore(answerRow("8")) === 50,
);
check(
    "a leaf carrying an option weighted 0 scores 0",
    weightScore(answerRow("9")) === 0,
);
check(
    "an unanswered leaf scores 0",
    weightScore({ id: 1, parent_id: null, status_id: 1, custom_values: [] }) === 0,
);
check(
    "a leaf with a blank answer scores 0",
    weightScore(answerRow(null)) === 0,
);
check(
    "an answer naming an option that no longer exists scores 0, not a guess",
    weightScore(answerRow("404")) === 0,
);
check(
    "an answer to another column is ignored",
    weightScore({ id: 1, parent_id: null, status_id: 1, custom_values: [answer(4, "7")] }) === 0,
);

// The mean is untouched: a parent averages its children's WEIGHTED scores.
const weightedRows: CompletionRow[] = [
    // Own answer is weighted 100, but a parent's own answer never enters its own number.
    { id: 90, parent_id: null, status_id: 1, custom_values: [answer(3, "7")] },
    { id: 91, parent_id: 90, status_id: 2, custom_values: [answer(3, "8")] },
    { id: 92, parent_id: 90, status_id: 1, custom_values: [] },
    // A removed choice is a 0 in the mean, exactly like an unanswered row.
    { id: 93, parent_id: 90, status_id: 1, custom_values: [answer(3, "404")] },
    { id: 94, parent_id: 90, status_id: 1, custom_values: [answer(3, "7")] },
];
const weightedRollup = computeCompletion(weightedRows, columnWeightScore(3, optionWeights));
check(
    "a parent averages its weighted leaves (100, 50, 0, 0 -> 37.5)",
    near(weightedRollup.valueById.get(90), 37.5),
);
check(
    "the weighted mean stays unfloored, so it prints 37%",
    formatCompletionPercent(weightedRollup.valueById.get(90) ?? 0) === "37%",
);
check(
    "a parent's own weighted answer is ignored in the mean",
    near(weightedRollup.ownById.get(90), 100),
);

// --- The row window: prefix-sum offsets, binary-searched slice --------------------------------------
const windowOffsets = buildOffsets([40, 56, 40, 72]);
check(
    "offsets are prefix sums ending in the total height",
    sameIds(windowOffsets, [0, 40, 96, 136, 208]),
    JSON.stringify(windowOffsets),
);

const emptyWindow = windowFor(buildOffsets([]), 0, 600, 10);
check("an empty list windows to nothing", emptyWindow.start === 0 && emptyWindow.end === 0);

const loneWindow = windowFor(buildOffsets([40]), 0, 600, 10);
check(
    "a single row is the whole window, whatever the overscan",
    loneWindow.start === 0 && loneWindow.end === 1,
);

const onBoundary = windowFor(windowOffsets, 96, 40, 0);
check(
    "a viewport starting exactly on an offset mounts that one row",
    onBoundary.start === 2 && onBoundary.end === 3,
);

const twoRows = windowFor(windowOffsets, 40, 100, 0);
check(
    "a viewport spanning two rows returns both, end exclusive",
    twoRows.start === 1 && twoRows.end === 3,
);

check("overscan clamps at the first row", windowFor(windowOffsets, 0, 40, 10).start === 0);
check("overscan clamps at the last row", windowFor(windowOffsets, 136, 72, 10).end === 4);

const tallOffsets = buildOffsets(Array.from({ length: 30 }, () => 40));
const middle = windowFor(tallOffsets, 600, 80, 10);
check(
    "overscan adds rows above and below one in the middle",
    middle.start === 5 && middle.end === 27,
    `${middle.start}..${middle.end}`,
);

const pastEnd = windowFor(tallOffsets, 5000, 80, 10);
check(
    "a scroll beyond the end still mounts the last row",
    pastEnd.start === 19 && pastEnd.end === 30,
    `${pastEnd.start}..${pastEnd.end}`,
);

const tallTop = windowFor(tallOffsets, 0, 120, 10);
check(
    "the top of the list ignores overscan above row 0",
    tallTop.start === 0 && tallTop.end === 13,
);

check(
    "the window never runs past the last row",
    windowFor(tallOffsets, 1200, 120, 10).end === 30,
);

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

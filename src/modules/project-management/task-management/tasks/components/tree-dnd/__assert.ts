/**
 * Assertion harness for the task tree's drag-and-drop engine.
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/task-management/tasks/components/tree-dnd/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * The harness exercises the exact functions `TreeDndProvider`'s handlers and collision detector call,
 * so the vertical before/after intent, the horizontal depth projection, same-level reorders,
 * cross-level re-parents, the over-cap behaviour and the cycle guard are all asserted without a DOM.
 * Why the `.ts` extension and the directive: Node resolves a relative import only when the specifier
 * carries the real file extension, while `tsc` rejects a `.ts` specifier unless
 * `allowImportingTsExtensions` is on — and the project `tsconfig.json` (a protected scaffold file this
 * module may not edit) does not enable it. The directive suppresses only that extension complaint;
 * the module is still fully resolved and typed by `tsc`, so `npx tsc --noEmit` stays green alongside
 * this Node run.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { computeMovePayload, droppableTargetIds, intentFromKeyboard, isCycleTarget, listChildIds, projectDepth, resolveDropIntent, resolveProjectedDrop, type FlatRow, type MovePayload } from "./dnd-logic.ts";

/** Mirrors `INDENT_STEP_PX` in `TaskRow.tsx`; this pure harness cannot import a `.tsx` constant. */
const INDENT_STEP_PX = 32;

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

function sameIdSet(actual: ReadonlySet<number>, expected: readonly number[]): boolean {
    return actual.size === expected.length && expected.every((id) => actual.has(id));
}

/** Applies a payload the way the move route would, so the read-back order can be asserted. */
function applyPayload(rows: readonly FlatRow[], payload: MovePayload, activeId: number): FlatRow[] {
    return rows.map((row) => {
        if (row.id === activeId) {
            return { ...row, parent_id: payload.parent_id, sort_order: payload.sibling_ids.indexOf(activeId) };
        }
        const index = payload.sibling_ids.indexOf(row.id);
        return index === -1 ? row : { ...row, sort_order: index };
    });
}

function parentOfRow(rows: readonly FlatRow[], id: number): number | null {
    const row = rows.find((candidate) => candidate.id === id);
    return row === undefined ? null : row.parent_id;
}

function depthOfRow(rows: readonly FlatRow[], id: number): number {
    return rows.find((candidate) => candidate.id === id)?.depth ?? 0;
}

/**
 * 1 (d0) -> 2, 3 (d1)         4 (d0) -> 5, 6 (d1)
 */
const rows: FlatRow[] = [
    { id: 1, parent_id: null, sort_order: 0, depth: 0 },
    { id: 2, parent_id: 1, sort_order: 0, depth: 1 },
    { id: 3, parent_id: 1, sort_order: 1, depth: 1 },
    { id: 4, parent_id: null, sort_order: 1, depth: 0 },
    { id: 5, parent_id: 4, sort_order: 0, depth: 1 },
    { id: 6, parent_id: 4, sort_order: 1, depth: 1 },
];

/** Resolves a drop the way the provider does: source depth + the horizontal offset's steps. */
function dropAt(activeId: number, overId: number, intent: "before" | "after", deltaX: number) {
    return resolveProjectedDrop({
        visibleRows: rows,
        allRows: rows,
        activeId,
        overId,
        intent,
        projectedDepth: projectDepth(depthOfRow(rows, activeId), deltaX, INDENT_STEP_PX),
    });
}

// --- Drop intent from the pointer's vertical half -----------------------------------------------

check(
    "the top third reads as insert-before",
    resolveDropIntent({ pointerY: 92, rectTop: 90, rectHeight: 30 }) === "before",
);
check(
    "just above the vertical midpoint reads as insert-before",
    resolveDropIntent({ pointerY: 104, rectTop: 90, rectHeight: 30 }) === "before",
);
check(
    "the vertical midpoint reads as insert-after",
    resolveDropIntent({ pointerY: 105, rectTop: 90, rectHeight: 30 }) === "after",
);
check(
    "the bottom third reads as insert-after",
    resolveDropIntent({ pointerY: 118, rectTop: 90, rectHeight: 30 }) === "after",
);
check(
    "an unmeasured rect defaults to insert-after",
    resolveDropIntent({ pointerY: 105, rectTop: 90, rectHeight: 0 }) === "after",
);
check("keyboard drag upward reads as insert-before", intentFromKeyboard(-8) === "before");
check("keyboard drag downward reads as insert-after", intentFromKeyboard(8) === "after");

// --- Horizontal depth projection -----------------------------------------------------------------

check("no horizontal movement keeps the source's depth", projectDepth(2, 0, INDENT_STEP_PX) === 2);
check("one step right nests one level", projectDepth(2, INDENT_STEP_PX, INDENT_STEP_PX) === 3);
check("two steps right nests two levels", projectDepth(1, 2 * INDENT_STEP_PX, INDENT_STEP_PX) === 3);
check("one step left promotes one level", projectDepth(2, -INDENT_STEP_PX, INDENT_STEP_PX) === 1);
check(
    "a left drag past the root clamps at depth 0",
    projectDepth(1, -10 * INDENT_STEP_PX, INDENT_STEP_PX) === 0,
);
check(
    "a row deeper than the visual cap keeps its true depth",
    projectDepth(12, 0, INDENT_STEP_PX) === 12,
);
check(
    "a row deeper than the visual cap can still nest deeper",
    projectDepth(12, INDENT_STEP_PX, INDENT_STEP_PX) === 13,
);
check(
    "a row deeper than the visual cap can still be promoted to root",
    projectDepth(12, -20 * INDENT_STEP_PX, INDENT_STEP_PX) === 0,
);
check("a zero indent step leaves the source depth unchanged", projectDepth(3, 999, 0) === 3);

// --- Same-level reorder preserved (vertical-only, deltaX 0) --------------------------------------

const reorder = dropAt(2, 3, "after", 0);
check(
    "a simulated sibling drag emits the post-drop order",
    reorder !== null && reorder.depth === 1 && reorder.payload.parent_id === 1 && sameIds(reorder.payload.sibling_ids, [3, 2]),
    reorder === null ? "payload was null" : `saw ${JSON.stringify(reorder)}`,
);
check(
    "a permitted reorder keeps the dragged row's existing parent",
    reorder !== null && reorder.payload.parent_id === parentOfRow(rows, 2),
);
check(
    "the emitted sibling_ids contains the moved node exactly once",
    reorder !== null && reorder.payload.sibling_ids.filter((id) => id === 2).length === 1,
);
check(
    "splicing the moved node at the chosen position reads back as sent",
    reorder !== null &&
        sameIds(listChildIds(applyPayload(rows, reorder.payload, 2), reorder.payload.parent_id), reorder.payload.sibling_ids),
);

const beforeSibling = dropAt(3, 2, "before", 0);
check(
    "an insert-before on a sibling emits the complete list with the moved node exactly once",
    beforeSibling !== null &&
        beforeSibling.depth === 1 &&
        beforeSibling.payload.parent_id === 1 &&
        sameIds(beforeSibling.payload.sibling_ids, [3, 2]),
    beforeSibling === null ? "payload was null" : `saw ${JSON.stringify(beforeSibling)}`,
);

// --- Cross-level re-parent is now the point (horizontal offset sets depth) -----------------------

const crossParent = dropAt(2, 5, "before", 0);
check(
    "a drop before a row under another parent re-parents into that parent",
    crossParent !== null &&
        crossParent.depth === 1 &&
        crossParent.payload.parent_id === 4 &&
        sameIds(crossParent.payload.sibling_ids, [2, 5, 6]),
    crossParent === null ? "payload was null" : `saw ${JSON.stringify(crossParent)}`,
);
const crossParentAfter = dropAt(2, 5, "after", 0);
check(
    "a drop after a row under another parent re-parents into that parent",
    crossParentAfter !== null &&
        crossParentAfter.payload.parent_id === 4 &&
        sameIds(crossParentAfter.payload.sibling_ids, [5, 2, 6]),
    crossParentAfter === null ? "payload was null" : `saw ${JSON.stringify(crossParentAfter)}`,
);
const toRoot = dropAt(2, 4, "before", -INDENT_STEP_PX);
check(
    "a child dragged left to depth 0 before a root row moves to root (parent_id null)",
    toRoot !== null && toRoot.depth === 0 && toRoot.payload.parent_id === null && sameIds(toRoot.payload.sibling_ids, [1, 2, 4]),
    toRoot === null ? "payload was null" : `saw ${JSON.stringify(toRoot)}`,
);
const childBeforeRoot = dropAt(2, 4, "before", 0);
check(
    "a plain vertical drop before a root row keeps the child's own level",
    childBeforeRoot !== null && childBeforeRoot.depth === 1 && childBeforeRoot.payload.parent_id === 1,
    childBeforeRoot === null ? "payload was null" : `saw ${JSON.stringify(childBeforeRoot)}`,
);
const rootBeforeChild = dropAt(4, 2, "before", 0);
check(
    "a root dropped before another branch's child row stays at root level",
    rootBeforeChild !== null &&
        rootBeforeChild.depth === 0 &&
        rootBeforeChild.payload.parent_id === null &&
        sameIds(rootBeforeChild.payload.sibling_ids, [1, 4]),
    rootBeforeChild === null ? "payload was null" : `saw ${JSON.stringify(rootBeforeChild)}`,
);
const unrelated = dropAt(5, 2, "before", 0);
check(
    "an unrelated cross-parent drop re-parents into the hovered row's level",
    unrelated !== null && unrelated.payload.parent_id === 1 && sameIds(unrelated.payload.sibling_ids, [5, 2, 3]),
    unrelated === null ? "payload was null" : `saw ${JSON.stringify(unrelated)}`,
);

// --- Right drag nests under the hovered row ------------------------------------------------------

const nested = dropAt(3, 2, "after", INDENT_STEP_PX);
check(
    "a right drag after a row nests the dragged row as that row's last child",
    nested !== null && nested.depth === 2 && nested.payload.parent_id === 2 && sameIds(nested.payload.sibling_ids, [3]),
    nested === null ? "payload was null" : `saw ${JSON.stringify(nested)}`,
);
check(
    "the resolved depth is the payload parent's depth + 1",
    nested !== null && nested.depth === depthOfRow(rows, nested.payload.parent_id ?? 0) + 1,
);

/** 1 (d0) -> 2 (d1) -> 7 (d2) — a two-level fixture for promotion. */
const nestedRows: FlatRow[] = [
    { id: 1, parent_id: null, sort_order: 0, depth: 0 },
    { id: 2, parent_id: 1, sort_order: 0, depth: 1 },
    { id: 7, parent_id: 2, sort_order: 0, depth: 2 },
];
const promoted = resolveProjectedDrop({
    visibleRows: nestedRows,
    allRows: nestedRows,
    activeId: 7,
    overId: 2,
    intent: "before",
    projectedDepth: projectDepth(2, -INDENT_STEP_PX, INDENT_STEP_PX),
});
check(
    "a left drag promotes a nested row to its grandparent's level",
    promoted !== null && promoted.depth === 1 && promoted.payload.parent_id === 1 && sameIds(promoted.payload.sibling_ids, [7, 2]),
    promoted === null ? "payload was null" : `saw ${JSON.stringify(promoted)}`,
);

// --- Cycle refusal (unchanged rule: self + descendants are never targets) -------------------------

check("the moved node is a cycle target for itself", isCycleTarget(rows, 1, 1));
check("a child is a cycle target for its parent", isCycleTarget(rows, 1, 2));
check("a deep descendant is a cycle target", isCycleTarget(rows, 1, 3));
check("an unrelated row is not a cycle target", !isCycleTarget(rows, 1, 4));
check("root is never a cycle target", !isCycleTarget(rows, 1, null));

const descendantDrop = resolveProjectedDrop({
    visibleRows: rows,
    allRows: rows,
    activeId: 1,
    overId: 3,
    intent: "before",
    projectedDepth: 0,
});
check(
    "a drop onto the dragged node's own descendant emits no payload (cycle refused)",
    descendantDrop === null,
    descendantDrop === null ? "" : `saw ${JSON.stringify(descendantDrop)}`,
);
check(
    "a node dropped onto itself emits nothing",
    resolveProjectedDrop({ visibleRows: rows, allRows: rows, activeId: 2, overId: 2, intent: "after", projectedDepth: 1 }) === null,
);
check("computeMovePayload refuses a self-parent", computeMovePayload(rows, 1, 1, 0) === null);
check("computeMovePayload refuses a descendant parent", computeMovePayload(rows, 1, 2, 0) === null);
check(
    "computeMovePayload accepts a cross-level destination now",
    (() => {
        const payload = computeMovePayload(rows, 2, 4, 0);
        return payload !== null && payload.parent_id === 4 && sameIds(payload.sibling_ids, [2, 5, 6]);
    })(),
);
check(
    "computeMovePayload accepts the source's own parent and keeps it",
    (() => {
        const payload = computeMovePayload(rows, 2, 1, 1);
        return payload !== null && payload.parent_id === parentOfRow(rows, 2) && sameIds(payload.sibling_ids, [3, 2]);
    })(),
);

// --- Cycle-safe target set (the collision-layer guard) -------------------------------------------

check(
    "the target set for a root is every row outside its subtree",
    sameIdSet(droppableTargetIds(rows, 1), [4, 5, 6]),
);
check("a descendant is never a legal target", !droppableTargetIds(rows, 1).has(2));
check("the dragged node itself is never a legal target", !droppableTargetIds(rows, 1).has(1));
check(
    "the target set for a leaf is every other row",
    sameIdSet(droppableTargetIds(rows, 2), [1, 3, 4, 5, 6]),
);
check(
    "the target set for a branch keeps unrelated rows and drops its descendants",
    sameIdSet(droppableTargetIds(rows, 4), [1, 2, 3]),
);

// --- Rows deeper than the visual cap -------------------------------------------------------------

/** 100 (d0) sits beside a 13-row chain 200 (d0) -> 201 (d1) -> ... -> 212 (d12). */
const deepRows: FlatRow[] = [
    { id: 100, parent_id: null, sort_order: 0, depth: 0 },
    ...Array.from({ length: 13 }, (_unused, index) => ({
        id: 200 + index,
        parent_id: index === 0 ? null : 199 + index,
        sort_order: index === 0 ? 1 : 0,
        depth: index,
    })),
];
const deepNest = resolveProjectedDrop({
    visibleRows: deepRows,
    allRows: deepRows,
    activeId: 100,
    overId: 212,
    intent: "after",
    projectedDepth: projectDepth(0, 20 * INDENT_STEP_PX, INDENT_STEP_PX),
});
check(
    "a shallow row can nest under a row deeper than the visual cap",
    deepNest !== null && deepNest.depth === 13 && deepNest.payload.parent_id === 212,
    deepNest === null ? "payload was null" : `saw ${JSON.stringify(deepNest)}`,
);
const deepClamp = resolveProjectedDrop({
    visibleRows: deepRows,
    allRows: deepRows,
    activeId: 212,
    overId: 201,
    intent: "before",
    projectedDepth: projectDepth(12, 0, INDENT_STEP_PX),
});
check(
    "a deep row projected before a shallow row clamps to the nearest real level",
    deepClamp !== null && deepClamp.depth === 1 && deepClamp.payload.parent_id === 200,
    deepClamp === null ? "payload was null" : `saw ${JSON.stringify(deepClamp)}`,
);

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

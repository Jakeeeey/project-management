/**
 * Assertion harness for the task tree's drag-and-drop engine.
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/task-management/tasks/components/tree-dnd/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * The harness exercises the exact functions `TreeDndProvider`'s handlers and collision detector call,
 * so the three-zone intent (including boundaries and hysteresis), the before/after and nest
 * destinations, the neighbour-based depth clamp, root-level gaps, the keyboard intent ring and the
 * cycle guard are all asserted without a DOM. Why the `.ts` extension and the directive: Node
 * resolves a relative import only when the specifier carries the real file extension, while `tsc`
 * rejects a `.ts` specifier unless `allowImportingTsExtensions` is on — and the project
 * `tsconfig.json` (a protected scaffold file this module may not edit) does not enable it. The
 * directive suppresses only that extension complaint; the module is still fully resolved and typed
 * by `tsc`, so `npx tsc --noEmit` stays green alongside this Node run.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { computeMovePayload, cycleDropIntent, droppableTargetIds, isCycleTarget, listChildIds, resolveDropDestination, resolveDropIntent, type DropIntent, type FlatRow, type MovePayload } from "./dnd-logic.ts";

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

/** Resolves a drop exactly the way the provider does — intent only, no drag offset. */
function dropAt(activeId: number, overId: number, intent: DropIntent) {
    return resolveDropDestination({
        visibleRows: rows,
        allRows: rows,
        activeId,
        overId,
        intent,
    });
}

// --- Intent from the pointer's vertical third ----------------------------------------------------

const ROW_TOP = 90;
const ROW_HEIGHT = 30;

function intentAt(pointerY: number, previous: DropIntent | null = null): DropIntent {
    return resolveDropIntent({ pointerY, rectTop: ROW_TOP, rectHeight: ROW_HEIGHT, previous });
}

check("the top third reads as insert-before", intentAt(94) === "before");
check("a pointer near the top of the row reads as insert-before", intentAt(99) === "before");
check("the 1/3 boundary belongs to the nest zone", intentAt(100) === "nest");
check("the middle third reads as nest", intentAt(105) === "nest");
check("the 2/3 boundary belongs to the insert-after zone", intentAt(110) === "after");
check("the bottom third reads as insert-after", intentAt(116) === "after");
check(
    "an unmeasured rect defaults to insert-after",
    resolveDropIntent({ pointerY: 105, rectTop: ROW_TOP, rectHeight: 0 }) === "after",
);

// Hysteresis: while an intent is active, its own edge is widened so a pointer resting on a boundary
// holds that intent. Each pair is the SAME pointer position with and without the prior intent.
check("hysteresis holds insert-before just past the 1/3 edge", intentAt(101, "before") === "before");
check("the same position with no prior intent resolves to nest", intentAt(101, null) === "nest");
check("hysteresis holds nest just above the 1/3 edge", intentAt(99, "nest") === "nest");
check("the same position with no prior intent resolves to insert-before", intentAt(99, null) === "before");
check("hysteresis holds nest just past the 2/3 edge", intentAt(111, "nest") === "nest");
check("the same position with no prior intent resolves to insert-after", intentAt(111, null) === "after");
check("hysteresis holds insert-after just above the 2/3 edge", intentAt(109, "after") === "after");
check("the same position with no prior intent resolves to nest", intentAt(109, null) === "nest");

// --- Keyboard intent ring (Left/Right cycle before → nest → after) --------------------------------

check("Right steps insert-before to nest", cycleDropIntent("before", 1) === "nest");
check("Right steps nest to insert-after", cycleDropIntent("nest", 1) === "after");
check("Right wraps insert-after back to insert-before", cycleDropIntent("after", 1) === "before");
check("Left steps insert-before back to insert-after", cycleDropIntent("before", -1) === "after");
check("Left steps insert-after to nest", cycleDropIntent("after", -1) === "nest");
check("Left steps nest to insert-before", cycleDropIntent("nest", -1) === "before");

// --- Before/after reorder among the hovered row's siblings ---------------------------------------

const reorder = dropAt(2, 3, "after");
check(
    "a simulated sibling drag emits the post-drop order",
    reorder !== null && reorder.depth === 1 && reorder.parentId === 1 && sameIds(reorder.payload.sibling_ids, [3, 2]),
    reorder === null ? "payload was null" : `saw ${JSON.stringify(reorder)}`,
);
check(
    "the destination parent is the hovered row's own parent",
    reorder !== null && reorder.payload.parent_id === parentOfRow(rows, 3),
);
check(
    "the emitted sibling_ids contains the moved node exactly once",
    reorder !== null && reorder.payload.sibling_ids.filter((id) => id === 2).length === 1,
);
check(
    "splicing the moved node at the chosen position reads back as sent",
    reorder !== null &&
        sameIds(
            listChildIds(applyPayload(rows, reorder.payload, 2), reorder.payload.parent_id),
            reorder.payload.sibling_ids,
        ),
);

const beforeSibling = dropAt(3, 2, "before");
check(
    "an insert-before on a sibling emits the complete list with the moved node exactly once",
    beforeSibling !== null &&
        beforeSibling.depth === 1 &&
        beforeSibling.parentId === 1 &&
        sameIds(beforeSibling.payload.sibling_ids, [3, 2]),
    beforeSibling === null ? "payload was null" : `saw ${JSON.stringify(beforeSibling)}`,
);

const crossParent = dropAt(2, 5, "before");
check(
    "a drop before a row under another parent joins that row's parent",
    crossParent !== null &&
        crossParent.depth === 1 &&
        crossParent.payload.parent_id === 4 &&
        sameIds(crossParent.payload.sibling_ids, [2, 5, 6]),
    crossParent === null ? "payload was null" : `saw ${JSON.stringify(crossParent)}`,
);
const crossParentAfter = dropAt(2, 5, "after");
check(
    "a drop after a row under another parent joins that row's parent",
    crossParentAfter !== null &&
        crossParentAfter.payload.parent_id === 4 &&
        sameIds(crossParentAfter.payload.sibling_ids, [5, 2, 6]),
    crossParentAfter === null ? "payload was null" : `saw ${JSON.stringify(crossParentAfter)}`,
);

// CHANGED from the offset model: the old assertion kept a root at root level when dropped before a
// child row. Under the intent model "before a row" means "join that row's parent", so the drop now
// joins parent 1 at the child's level. Root-level gaps are asserted separately below.
const rootBeforeChild = dropAt(4, 2, "before");
check(
    "a drop before another branch's child joins that child's parent at its level",
    rootBeforeChild !== null &&
        rootBeforeChild.depth === 1 &&
        rootBeforeChild.payload.parent_id === 1 &&
        sameIds(rootBeforeChild.payload.sibling_ids, [4, 2, 3]),
    rootBeforeChild === null ? "payload was null" : `saw ${JSON.stringify(rootBeforeChild)}`,
);
const unrelated = dropAt(5, 2, "before");
check(
    "an unrelated cross-parent drop joins the hovered row's parent",
    unrelated !== null && unrelated.payload.parent_id === 1 && sameIds(unrelated.payload.sibling_ids, [5, 2, 3]),
    unrelated === null ? "payload was null" : `saw ${JSON.stringify(unrelated)}`,
);

// --- Neighbour clamp (minDepth from the row below, maxDepth from the row above) -------------------

// The bottom third of an expanded parent sits visually above that parent's first visible child, so
// the next neighbour (depth 1) raises the plain "sibling" level (0) to the child's level: the drop
// lands as the parent's first child. This is the neighbour clamp replacing ancestry validation.
const clampedToChild = dropAt(2, 4, "after");
check(
    "a bottom-third drop on an expanded parent clamps up to become its first child",
    clampedToChild !== null &&
        clampedToChild.depth === 1 &&
        clampedToChild.payload.parent_id === 4 &&
        sameIds(clampedToChild.payload.sibling_ids, [2, 5, 6]),
    clampedToChild === null ? "payload was null" : `saw ${JSON.stringify(clampedToChild)}`,
);

// A shown indicator must always resolve to a payload. Dropping after a parent whose next visible row
// is the dragged row itself is the case a flat "remove the active row" simulation mishandles: the
// neighbour below the gap becomes the dragged row's own child and no parent is found. Reading the
// live list keeps this a valid sibling no-op instead of an empty drop.
const parentWithChildRows: FlatRow[] = [
    { id: 1, parent_id: null, sort_order: 0, depth: 0 },
    { id: 2, parent_id: 1, sort_order: 0, depth: 1 },
    { id: 7, parent_id: 2, sort_order: 0, depth: 2 },
    { id: 3, parent_id: 1, sort_order: 1, depth: 1 },
];
const afterOwnParent = resolveDropDestination({
    visibleRows: parentWithChildRows,
    allRows: parentWithChildRows,
    activeId: 2,
    overId: 1,
    intent: "after",
});
check(
    "a bottom-third drop after the dragged row's own parent resolves to a sibling no-op",
    afterOwnParent !== null &&
        afterOwnParent.depth === 1 &&
        afterOwnParent.payload.parent_id === 1 &&
        sameIds(afterOwnParent.payload.sibling_ids, [2, 3]),
    afterOwnParent === null ? "payload was null" : `saw ${JSON.stringify(afterOwnParent)}`,
);

// --- Root-level destinations (parent_id null is legitimate in a top-level gap) --------------------

const toRoot = dropAt(2, 4, "before");
check(
    "a drop before a root row lands at root level (parent_id null)",
    toRoot !== null && toRoot.depth === 0 && toRoot.payload.parent_id === null && sameIds(toRoot.payload.sibling_ids, [1, 2, 4]),
    toRoot === null ? "payload was null" : `saw ${JSON.stringify(toRoot)}`,
);
const anotherRoot = dropAt(6, 4, "before");
check(
    "another root dropped in the top-level gap joins the root list in order",
    anotherRoot !== null &&
        anotherRoot.depth === 0 &&
        anotherRoot.payload.parent_id === null &&
        sameIds(anotherRoot.payload.sibling_ids, [1, 6, 4]),
    anotherRoot === null ? "payload was null" : `saw ${JSON.stringify(anotherRoot)}`,
);

// --- Nest intent (drop ON the hovered row = become its last child) --------------------------------

const nested = dropAt(3, 2, "nest");
check(
    "a nest drop makes the hovered row the parent and appends as its last child",
    nested !== null && nested.depth === 2 && nested.payload.parent_id === 2 && sameIds(nested.payload.sibling_ids, [3]),
    nested === null ? "payload was null" : `saw ${JSON.stringify(nested)}`,
);
check(
    "the resolved depth is the nest parent's depth + 1",
    nested !== null && nested.payload.parent_id !== null && nested.depth === (rows.find((row) => row.id === nested.payload.parent_id)?.depth ?? 0) + 1,
);

const appendedNest = dropAt(2, 1, "nest");
check(
    "nesting into a row that already has children appends after them",
    appendedNest !== null &&
        appendedNest.depth === 1 &&
        appendedNest.payload.parent_id === 1 &&
        sameIds(appendedNest.payload.sibling_ids, [3, 2]),
    appendedNest === null ? "payload was null" : `saw ${JSON.stringify(appendedNest)}`,
);

// --- Cycle refusal (unchanged rule: self + descendants are never targets) -------------------------

check("the moved node is a cycle target for itself", isCycleTarget(rows, 1, 1));
check("a child is a cycle target for its parent", isCycleTarget(rows, 1, 2));
check("a deep descendant is a cycle target", isCycleTarget(rows, 1, 3));
check("an unrelated row is not a cycle target", !isCycleTarget(rows, 1, 4));
check("root is never a cycle target", !isCycleTarget(rows, 1, null));

check(
    "a before drop onto the dragged node's own descendant emits no payload (cycle refused)",
    dropAt(1, 3, "before") === null,
);
check(
    "a nest drop onto the dragged node's own descendant emits no payload (cycle refused)",
    dropAt(1, 3, "nest") === null,
);
check(
    "a node dropped onto itself emits nothing",
    resolveDropDestination({ visibleRows: rows, allRows: rows, activeId: 2, overId: 2, intent: "after" }) === null,
);
check("computeMovePayload refuses a self-parent", computeMovePayload(rows, 1, 1, 0) === null);
check("computeMovePayload refuses a descendant parent", computeMovePayload(rows, 1, 2, 0) === null);
check("computeMovePayload refuses a deeper descendant parent", computeMovePayload(rows, 1, 3, 0) === null);
check(
    "computeMovePayload accepts a cross-level destination",
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
check(
    "computeMovePayload accepts a root destination",
    (() => {
        const payload = computeMovePayload(rows, 1, null, 0);
        return payload !== null && payload.parent_id === null && sameIds(payload.sibling_ids, [1, 4]);
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
const deepNest = resolveDropDestination({
    visibleRows: deepRows,
    allRows: deepRows,
    activeId: 100,
    overId: 212,
    intent: "nest",
});
check(
    "a shallow row can nest under a row deeper than the visual cap",
    deepNest !== null && deepNest.depth === 13 && deepNest.payload.parent_id === 212,
    deepNest === null ? "payload was null" : `saw ${JSON.stringify(deepNest)}`,
);
const deepBefore = resolveDropDestination({
    visibleRows: deepRows,
    allRows: deepRows,
    activeId: 212,
    overId: 201,
    intent: "before",
});
check(
    "a deep row dropped before a shallow row clamps to the shallow row's level",
    deepBefore !== null &&
        deepBefore.depth === 1 &&
        deepBefore.payload.parent_id === 200 &&
        sameIds(deepBefore.payload.sibling_ids, [212, 201]),
    deepBefore === null ? "payload was null" : `saw ${JSON.stringify(deepBefore)}`,
);

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

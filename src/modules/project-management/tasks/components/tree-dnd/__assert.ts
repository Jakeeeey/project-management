/**
 * Phase-A assertion harness for the task tree's drag-and-drop engine.
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/tasks/components/tree-dnd/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * The harness exercises the exact functions `TreeDndProvider`'s `onDragOver` / `onDragEnd` handlers
 * call, so a simulated sibling drag and a nest onto a descendant are asserted without a DOM. Why the
 * `.ts` extension and the directive: Node resolves a relative import only when the specifier carries
 * the real file extension, while `tsc` rejects a `.ts` specifier unless `allowImportingTsExtensions`
 * is on — and the project `tsconfig.json` (a protected scaffold file this module may not edit) does
 * not enable it. The directive suppresses only that extension complaint; the module is still fully
 * resolved and typed by `tsc`, so `npx tsc --noEmit` stays green alongside this Node run.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { computeMovePayload, intentFromKeyboard, isCycleTarget, listChildIds, resolveDropIntent, resolveDropPayload, type DndRow, type MovePayload } from "./dnd-logic.ts";

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

/** Applies a payload the way the move route would, so the read-back order can be asserted. */
function applyPayload(rows: readonly DndRow[], payload: MovePayload, activeId: number): DndRow[] {
    return rows.map((row) => {
        if (row.id === activeId) {
            return { ...row, parent_id: payload.parent_id, sort_order: payload.sibling_ids.indexOf(activeId) };
        }
        const index = payload.sibling_ids.indexOf(row.id);
        return index === -1 ? row : { ...row, sort_order: index };
    });
}

/**
 * 1 (root) -> 2, 3         4 (root) -> 5, 6
 */
const rows: DndRow[] = [
    { id: 1, parent_id: null, sort_order: 0 },
    { id: 2, parent_id: 1, sort_order: 0 },
    { id: 3, parent_id: 1, sort_order: 1 },
    { id: 4, parent_id: null, sort_order: 1 },
    { id: 5, parent_id: 4, sort_order: 0 },
    { id: 6, parent_id: 4, sort_order: 1 },
];

// --- Drop intent from the pointer's vertical third ---------------------------------------------

check(
    "the top third reads as insert-before",
    resolveDropIntent({ pointerY: 92, rectTop: 90, rectHeight: 30, overIsDescendant: false }) === "before",
);
check(
    "the middle third reads as nest",
    resolveDropIntent({ pointerY: 105, rectTop: 90, rectHeight: 30, overIsDescendant: false }) === "nest",
);
check(
    "the bottom third reads as insert-after",
    resolveDropIntent({ pointerY: 118, rectTop: 90, rectHeight: 30, overIsDescendant: false }) === "after",
);
check(
    "a nest onto the dragged node's own descendant emits the insert intent instead",
    resolveDropIntent({ pointerY: 105, rectTop: 90, rectHeight: 30, overIsDescendant: true }) === "before",
);
check(
    "a descendant row never offers the nest affordance",
    resolveDropIntent({ pointerY: 105, rectTop: 90, rectHeight: 30, overIsDescendant: true }) !== "nest",
);
check("keyboard drag upward reads as insert-before", intentFromKeyboard(-8) === "before");
check("keyboard drag downward reads as insert-after", intentFromKeyboard(8) === "after");

// --- Sibling reorder -----------------------------------------------------------------------------

const reorder = resolveDropPayload(rows, 2, 3, "after");
check(
    "a simulated sibling drag emits the post-drop order",
    reorder !== null && reorder.parent_id === 1 && sameIds(reorder.sibling_ids, [3, 2]),
    reorder === null ? "payload was null" : `saw ${JSON.stringify(reorder)}`,
);
check(
    "the emitted sibling_ids contains the moved node exactly once",
    reorder !== null && reorder.sibling_ids.filter((id) => id === 2).length === 1,
);
check(
    "splicing the moved node at the chosen position reads back as sent",
    reorder !== null && sameIds(listChildIds(applyPayload(rows, reorder, 2), reorder.parent_id), reorder.sibling_ids),
);

const beforeSibling = resolveDropPayload(rows, 3, 2, "before");
check(
    "an insert-before on a sibling emits the complete list with the moved node exactly once",
    beforeSibling !== null &&
        beforeSibling.parent_id === 1 &&
        sameIds(beforeSibling.sibling_ids, [3, 2]),
    beforeSibling === null ? "payload was null" : `saw ${JSON.stringify(beforeSibling)}`,
);

// --- Cross-parent move and move to root -----------------------------------------------------------

const crossParent = resolveDropPayload(rows, 2, 5, "before");
check(
    "a drop before a row under another parent re-parents into that parent",
    crossParent !== null &&
        crossParent.parent_id === 4 &&
        sameIds(crossParent.sibling_ids, [2, 5, 6]),
    crossParent === null ? "payload was null" : `saw ${JSON.stringify(crossParent)}`,
);
check(
    "the cross-parent payload keeps every existing sibling",
    crossParent !== null &&
        sameIds(listChildIds(applyPayload(rows, crossParent, 2), crossParent.parent_id), crossParent.sibling_ids),
);

const toRoot = resolveDropPayload(rows, 2, 4, "before");
check(
    "a drop before a root row moves the node to root (parent_id null)",
    toRoot !== null && toRoot.parent_id === null && sameIds(toRoot.sibling_ids, [1, 2, 4]),
    toRoot === null ? "payload was null" : `saw ${JSON.stringify(toRoot)}`,
);

const nested = resolveDropPayload(rows, 5, 2, "nest");
check(
    "a middle-third drop nests the node as the destination's last child",
    nested !== null && nested.parent_id === 2 && sameIds(nested.sibling_ids, [5]),
    nested === null ? "payload was null" : `saw ${JSON.stringify(nested)}`,
);

// --- Cycle refusal --------------------------------------------------------------------------------

check("the moved node is a cycle target for itself", isCycleTarget(rows, 1, 1));
check("a child is a cycle target for its parent", isCycleTarget(rows, 1, 2));
check("a deep descendant is a cycle target", isCycleTarget(rows, 1, 3));
check("an unrelated row is not a cycle target", !isCycleTarget(rows, 1, 4));
check("root is never a cycle target", !isCycleTarget(rows, 1, null));

const descendantDrop = resolveDropPayload(rows, 1, 3, "before");
check(
    "a drop onto the dragged node's own descendant emits no payload (cycle refused)",
    descendantDrop === null,
    descendantDrop === null ? "" : `saw ${JSON.stringify(descendantDrop)}`,
);
check("a node dropped onto itself emits nothing", resolveDropPayload(rows, 2, 2, "after") === null);
check("computeMovePayload refuses a self-parent", computeMovePayload(rows, 1, 1, 0) === null);
check("computeMovePayload refuses a descendant parent", computeMovePayload(rows, 1, 2, 0) === null);

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

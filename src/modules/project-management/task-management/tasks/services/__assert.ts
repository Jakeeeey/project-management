/**
 * Pure-logic assertion harness for the move route's completeness rule.
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/tasks/services/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * Why the `.ts` extensions and the `@ts-expect-error` directives: Node's loader resolves a relative
 * import only when the specifier carries the real file extension, while `tsc` rejects a `.ts`
 * specifier unless `allowImportingTsExtensions` is on — and the project `tsconfig.json` (a
 * protected scaffold file this module may not edit) does not enable it. The directives suppress
 * only that extension complaint; the module is still fully resolved and typed by `tsc`.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { containsExactlyOnce, isCompletePostMoveChildSet, type MoveChildRow } from "./task-move-rules.ts";

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

/** 1 -> {2, 3}; 5 -> {6}; 6 -> {7}. The cross-parent fixtures below move a node across this tree. */
const rows: MoveChildRow[] = [
    { id: 1, parent_id: null },
    { id: 2, parent_id: 1 },
    { id: 3, parent_id: 1 },
    { id: 5, parent_id: null },
    { id: 6, parent_id: 5 },
    { id: 7, parent_id: 6 },
];

// --- The membership trap ---------------------------------------------------------------------------
// 2 is NOT a child of 5 before the move; the rule must still accept it as part of 5's post-move set.
const movedParentBeforeMove = rows.find((row) => row.id === 2)?.parent_id;
const targetParentId: number = 5;
check(
    "fixture: the moved node is not yet a child of the target parent",
    movedParentBeforeMove === 1 && movedParentBeforeMove !== targetParentId,
);
check(
    "a cross-parent move is complete when the moved node is spliced into the target's children",
    isCompletePostMoveChildSet(rows, 2, 5, [6, 2]),
);
check(
    "the same move refuses the target's bare pre-move child list",
    !isCompletePostMoveChildSet(rows, 2, 5, [6]),
);
check(
    "a move to root accepts the moved node among the department's roots",
    isCompletePostMoveChildSet(rows, 3, null, [1, 3, 5]),
);
check(
    "a move to root is order-independent (completeness is a set question)",
    isCompletePostMoveChildSet(rows, 3, null, [3, 5, 1]),
);
check(
    "a move to root refuses a list that omits a root",
    !isCompletePostMoveChildSet(rows, 3, null, [1, 3]),
);

// --- Reorder within one parent ----------------------------------------------------------------------
check(
    "a pure reorder accepts the parent's complete child list with the moved node moved",
    isCompletePostMoveChildSet(rows, 2, 1, [3, 2]),
);
check(
    "a pure reorder accepts the no-op order too",
    isCompletePostMoveChildSet(rows, 2, 1, [2, 3]),
);

// --- Refusals ----------------------------------------------------------------------------------------
check("a partial sibling list is refused", !isCompletePostMoveChildSet(rows, 2, 5, [2]));
check("an unknown sibling id is refused", !isCompletePostMoveChildSet(rows, 2, 5, [6, 2, 999]));
check("a duplicate sibling id is refused", !isCompletePostMoveChildSet(rows, 2, 5, [6, 6, 2]));
check(
    "a sibling from another branch is refused",
    !isCompletePostMoveChildSet(rows, 2, 5, [3, 2]),
);
check(
    "a deeper target parent accepts the moved node plus its existing child",
    isCompletePostMoveChildSet(rows, 2, 6, [7, 2]),
);

// --- containsExactlyOnce -----------------------------------------------------------------------------
check("containsExactlyOnce accepts a single occurrence", containsExactlyOnce([2, 3], 2));
check("containsExactlyOnce refuses a repeated moved node", !containsExactlyOnce([2, 3, 2], 2));
check("containsExactlyOnce refuses an absent moved node", !containsExactlyOnce([1, 3], 2));

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

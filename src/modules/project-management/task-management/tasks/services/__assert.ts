/**
 * Pure-logic assertion harness for the tasks module's pure cores: the move route's completeness rule
 * (`./task-move-rules`) and the activity trail's delta computation (`./task-activity-delta`).
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
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { TASK_ACTIVITY_CUSTOM_FIELD_KEY, TASK_ACTIVITY_FIELD_LABELS, buildActivityChange, buildTaskActivityDeltas, catalogLabelOf, formatActivityValue, hasActivityChanged, joinUserDisplayName, type TaskActivityChange } from "./task-activity-delta.ts";

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

// --- The activity delta core: normalising the stored TEXT shape --------------------------------------
check("an absent value normalises to null", formatActivityValue(undefined) === null && formatActivityValue(null) === null);
check("a number becomes its decimal text", formatActivityValue(42) === "42");
check("a boolean becomes its text", formatActivityValue(false) === "false");
check("an empty string stays a value, not an absence", formatActivityValue("") === "");
check("an object has no text form and normalises to null", formatActivityValue({ id: 7 }) === null);
check(
    "buildActivityChange defaults a built-in's field_id to null",
    buildActivityChange({ field_key: "title", field_label: "Title", old_value: "A", new_value: "B" }).field_id === null,
);
check(
    "buildActivityChange carries a custom column's field_id",
    buildActivityChange({ field_key: TASK_ACTIVITY_CUSTOM_FIELD_KEY, field_id: 12, field_label: "Budget", old_value: null, new_value: "5" }).field_id === 12,
);

// --- The activity delta core: which changes are real --------------------------------------------------
const unchanged: TaskActivityChange = buildActivityChange({
    field_key: "title",
    field_label: TASK_ACTIVITY_FIELD_LABELS.title,
    old_value: "Same",
    new_value: "Same",
});
const relabelled: TaskActivityChange = buildActivityChange({
    field_key: "status_id",
    field_label: TASK_ACTIVITY_FIELD_LABELS.status_id,
    old_value: "3",
    new_value: "3",
    old_label: "Todo",
    new_label: "In progress",
});
const statusMoved: TaskActivityChange = buildActivityChange({
    field_key: "status_id",
    field_label: TASK_ACTIVITY_FIELD_LABELS.status_id,
    old_value: 3,
    new_value: 4,
    old_label: "Todo",
    new_label: "Done",
});
const cleared: TaskActivityChange = buildActivityChange({
    field_key: "assignee",
    field_label: TASK_ACTIVITY_FIELD_LABELS.assignee,
    old_value: 9,
    new_value: null,
    old_label: "Jane Cruz",
    new_label: null,
});

check("an identical before/after is not a change", !hasActivityChanged(unchanged));
check("a moved reference is a change", hasActivityChanged(statusMoved));
check("a re-pointed reference with an unchanged value is still a change", hasActivityChanged(relabelled));
check("clearing a value is a change", hasActivityChanged(cleared));
check(
    "an updated batch drops the no-op and the nil entries",
    buildTaskActivityDeltas("updated", [null, undefined, unchanged, statusMoved]).length === 1,
);
check(
    "an updated batch keeps the relabel and the clear",
    buildTaskActivityDeltas("updated", [relabelled, cleared]).length === 2,
);
check(
    "a created batch keeps every entry it is handed",
    buildTaskActivityDeltas("created", [unchanged, cleared]).length === 2,
);
check(
    "every delta carries the action it was built with",
    buildTaskActivityDeltas("created", [unchanged]).every((delta) => delta.action === "created"),
);
check(
    "a delete's row is a title with a null new side",
    buildTaskActivityDeltas("updated", [
        buildActivityChange({
            field_key: "title",
            field_label: TASK_ACTIVITY_FIELD_LABELS.title,
            old_value: "Ship it",
            new_value: null,
            old_label: "Ship it",
        }),
    ]).length === 1,
);
check(
    "a move's no-op parent lands in one row with its order",
    buildTaskActivityDeltas("updated", [
        buildActivityChange({ field_key: "parent_id", field_label: TASK_ACTIVITY_FIELD_LABELS.parent_id, old_value: 5, new_value: 5 }),
        buildActivityChange({ field_key: "sort_order", field_label: TASK_ACTIVITY_FIELD_LABELS.sort_order, old_value: 2, new_value: 0 }),
    ]).length === 1,
);

// --- The activity delta core: display-name snapshots --------------------------------------------------
check(
    "a display name joins all three columns",
    joinUserDisplayName({ user_fname: "Jane", user_mname: "Bautista", user_lname: "Cruz" }) === "Jane Bautista Cruz",
);
check(
    "a blank middle name is dropped rather than doubled",
    joinUserDisplayName({ user_fname: "Jane", user_mname: "", user_lname: "Cruz" }) === "Jane Cruz",
);
check(
    "the name pieces are trimmed",
    joinUserDisplayName({ user_fname: "  Jane ", user_lname: " Cruz" }) === "Jane Cruz",
);
check(
    "a wholly nameless user resolves to null, not an empty label",
    joinUserDisplayName({ user_fname: null, user_mname: "  ", user_lname: undefined }) === null,
);

// --- The activity delta core: catalog label snapshots --------------------------------------------------
const STATUSES = [
    { id: 3, label: "Todo" },
    { id: 4, label: "Done" },
];
check("a catalog label resolves from the loaded list", catalogLabelOf(STATUSES, 3) === "Todo");
check("a string-shaped id still resolves", catalogLabelOf(STATUSES, "4") === "Done");
check("a dangling catalog id has no label", catalogLabelOf(STATUSES, 999) === null);
check("an absent catalog id has no label", catalogLabelOf(STATUSES, null) === null);

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

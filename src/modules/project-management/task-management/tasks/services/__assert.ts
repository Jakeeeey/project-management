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
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { TaskListError, deleteListRefusal, duplicateNameRow, effectiveDefaultList, isListCompatible, resolveTaskListId, sortListRows } from "./task-list-policy.ts";

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

function ids(rows: readonly { readonly id: number }[]): string {
    return JSON.stringify(rows.map((row) => row.id));
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

// --- Task lists: ordering -------------------------------------------------------------------------

const GENERAL = { id: 1, name: "General", sort_order: 0, is_default: 1, is_deleted: 0 };
const MARKETING = { id: 2, name: "Marketing", sort_order: 1, is_default: 0, is_deleted: 0 };
const OPERATIONS = { id: 3, name: "Operations", sort_order: 2, is_default: 0, is_deleted: 0 };
const REMOVED_LIST = { id: 9, name: "General", sort_order: 0, is_default: 0, is_deleted: 1 };
const TIE_LATE_LIST = { id: 8, name: "Zeta", sort_order: 1, is_default: 0, is_deleted: 0 };
const TIE_EARLY_LIST = { id: 4, name: "Alpha", sort_order: 1, is_default: 0, is_deleted: 0 };
const FLAGGED_LATE_LIST = { id: 7, name: "Delta", sort_order: 9, is_default: 1, is_deleted: 0 };

check("list order sorts by (sort_order, id)", ids(sortListRows([OPERATIONS, MARKETING, GENERAL])) === "[1,2,3]");
check("list order breaks a sort_order tie by id", ids(sortListRows([TIE_LATE_LIST, TIE_EARLY_LIST])) === "[4,8]");

// --- Task lists: duplicate-name detection (no unique key to lean on) ------------------------------

const NAMED_LISTS = [GENERAL, MARKETING, REMOVED_LIST];

check("list names: an exact live match is found", duplicateNameRow(NAMED_LISTS, "Marketing")?.id === 2);
check("list names: a trimmed, case-only variant is still a duplicate", duplicateNameRow(NAMED_LISTS, "  marketing ")?.id === 2);
check("list names: a fresh name is free", duplicateNameRow(NAMED_LISTS, "Operations") === null);
check("list names: a list may keep its own name on update", duplicateNameRow(NAMED_LISTS, "General", 1) === null);
check("list names: a soft-deleted list never blocks reusing its name", duplicateNameRow([REMOVED_LIST], "General") === null);

// --- Task lists: default resolution (a missing flag must never strand task creation) --------------

check("list default: the flagged row wins over a lower unflagged one", effectiveDefaultList([MARKETING, FLAGGED_LATE_LIST])?.id === 7);
check("list default: with no flag, the lowest (sort_order, id) live row is used", effectiveDefaultList([OPERATIONS, MARKETING, { ...GENERAL, is_default: 0 }])?.id === 1);
check("list default: a sort_order tie resolves to the lower id", effectiveDefaultList([TIE_LATE_LIST, TIE_EARLY_LIST])?.id === 4);
check("list default: soft-deleted rows never serve as the default", effectiveDefaultList([REMOVED_LIST, MARKETING])?.id === 2);
check("list default: two flagged rows resolve deterministically to the lower id", effectiveDefaultList([{ ...MARKETING, is_default: 1 }, GENERAL])?.id === 1);
check("list default: a department with no list has no default", effectiveDefaultList([]) === null);
check("list default: an all-soft-deleted set has no default", effectiveDefaultList([REMOVED_LIST]) === null);

// --- Task lists: soft-delete guard -----------------------------------------------------------------

const TWO_LIVE_LISTS = [GENERAL, MARKETING];
const TWO_UNFLAGGED_LISTS = [{ ...GENERAL, is_default: 0 }, MARKETING];

check("list delete guard: the current default is refused", deleteListRefusal(TWO_LIVE_LISTS, 1) === "current-default");
check("list delete guard: a non-default list of a two-list department is allowed", deleteListRefusal(TWO_LIVE_LISTS, 2) === null);
check("list delete guard: a missing flag still protects the effective fallback", deleteListRefusal(TWO_UNFLAGGED_LISTS, 1) === "current-default");
check("list delete guard: the last live list is refused", deleteListRefusal([GENERAL], 1) === "last-live-row");
check("list delete guard: an id that is only soft-deleted is not-found", deleteListRefusal(TWO_LIVE_LISTS, 9) === "not-found");

// --- Task lists: the subtask/list exclusivity predicate --------------------------------------------

check("a root task (no parent list) is compatible with any list", isListCompatible(null, 5));
check("a subtask in the parent's list is compatible", isListCompatible(5, 5));
check("a subtask in another list is refused", !isListCompatible(5, 6));

// --- Task lists: the task-creation list resolution -------------------------------------------------

const RESOLUTION_LISTS = [GENERAL, MARKETING];

const explicitRoot = resolveTaskListId({ lists: RESOLUTION_LISTS, requestedListId: 2, parentListId: null });
check("a root task with an explicit live list resolves to it", explicitRoot.kind === "resolved" && explicitRoot.listId === 2);
const rootFallback = resolveTaskListId({ lists: RESOLUTION_LISTS, requestedListId: null, parentListId: null });
check("a root task that omits its list falls back to the default", rootFallback.kind === "resolved" && rootFallback.listId === 1);
check(
    "a root task that names an unknown list is refused",
    resolveTaskListId({ lists: RESOLUTION_LISTS, requestedListId: 99, parentListId: null }).kind === "unknown-list",
);
check(
    "a root task in a department with no list is refused",
    resolveTaskListId({ lists: [], requestedListId: null, parentListId: null }).kind === "no-list",
);
const inheritedSubtask = resolveTaskListId({ lists: RESOLUTION_LISTS, requestedListId: null, parentListId: 2 });
check("a subtask that omits its list inherits the parent's", inheritedSubtask.kind === "resolved" && inheritedSubtask.listId === 2);
const namedSubtask = resolveTaskListId({ lists: RESOLUTION_LISTS, requestedListId: 2, parentListId: 2 });
check("a subtask that names its parent's list is accepted", namedSubtask.kind === "resolved" && namedSubtask.listId === 2);
check(
    "a subtask that names another list is a mismatch",
    resolveTaskListId({ lists: RESOLUTION_LISTS, requestedListId: 1, parentListId: 2 }).kind === "subtask-list-mismatch",
);
check(
    "a subtask that names an unknown list is unknown, not a mismatch",
    resolveTaskListId({ lists: RESOLUTION_LISTS, requestedListId: 99, parentListId: 2 }).kind === "unknown-list",
);
const inheritedFromUnknownList = resolveTaskListId({ lists: RESOLUTION_LISTS, requestedListId: null, parentListId: 42 });
check(
    "a subtask trusts its parent's list even when that list is no longer live",
    inheritedFromUnknownList.kind === "resolved" && inheritedFromUnknownList.listId === 42,
);

// --- Task lists: coded error -----------------------------------------------------------------------

const listRefusal = new TaskListError("VALIDATION_FAILED", "a live task list already uses that name");
check(
    "TaskListError carries its code and a CODE-prefixed message",
    listRefusal instanceof Error && listRefusal.code === "VALIDATION_FAILED" && listRefusal.message.startsWith("VALIDATION_FAILED:"),
    listRefusal.message,
);

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

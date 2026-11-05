/**
 * Phase-A assertion harness for the task-configuration catalog policy.
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/task-management/configure/services/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * The predicates in `./task-config-policy` are the exact functions the catalog service calls, so
 * duplicate-label detection, the default fallback and the soft-delete guards are asserted without a
 * database. Why the `.ts` extension and the directive: Node resolves a relative import only when the
 * specifier carries the real file extension, while `tsc` rejects a `.ts` specifier unless
 * `allowImportingTsExtensions` is on — and the project `tsconfig.json` (a protected scaffold file
 * this module may not edit) does not enable it. The directive suppresses only that extension
 * complaint; the module is still fully resolved and typed by `tsc`, so `npx tsc --noEmit` stays
 * green alongside this Node run.
 *
 * Labels below are neutral placeholders on purpose: catalog VALUES may appear only in the service's
 * seed fixture.
 */
// @ts-expect-error -- Node >= 22.15 exports `registerHooks`; the pinned @types/node (20.x) predates it.
import { registerHooks } from "node:module";
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { TaskConfigError, deleteRefusal, duplicateLabelRow, effectiveDefaultRow, liveRows, sortCatalogRows } from "./task-config-policy.ts";

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

// Fixture rows. `is_default` / `is_deleted` are deliberately mixed shapes where the shape matters.
const ALPHA_DEFAULT = { id: 1, label: "Alpha", sort_order: 0, is_default: 1, is_deleted: 0 };
const BETA = { id: 2, label: "Beta", sort_order: 1, is_default: 0, is_deleted: 0 };
const GAMMA = { id: 3, label: "Gamma", sort_order: 2, is_default: 0, is_deleted: 0 };
const REMOVED_ALPHA = { id: 9, label: "Alpha", sort_order: 0, is_default: 0, is_deleted: 1 };
const TIE_LATE = { id: 8, label: "Epsilon", sort_order: 1, is_default: 0, is_deleted: 0 };
const TIE_EARLY = { id: 4, label: "Zeta", sort_order: 1, is_default: 0, is_deleted: 0 };
const FLAGGED_HIGH = { id: 7, label: "Delta", sort_order: 9, is_default: 1, is_deleted: 0 };

// --- Ordering ------------------------------------------------------------------------------------

check("sortCatalogRows orders by (sort_order, id)", ids(sortCatalogRows([GAMMA, BETA, ALPHA_DEFAULT])) === "[1,2,3]");
check("sortCatalogRows breaks a sort_order tie by id", ids(sortCatalogRows([TIE_LATE, TIE_EARLY])) === "[4,8]");

// --- Live-row reading ----------------------------------------------------------------------------

check("liveRows keeps rows that are not soft-deleted", liveRows([ALPHA_DEFAULT, BETA]).length === 2);
check("liveRows drops a soft-deleted row", ids(liveRows([ALPHA_DEFAULT, REMOVED_ALPHA])) === "[1]");
check(
    "liveRows reads a string-shaped flag and a boolean flag",
    ids(
        liveRows([
            { id: 5, label: "Eta", sort_order: 0, is_default: 0, is_deleted: "0" },
            { id: 6, label: "Theta", sort_order: 0, is_default: 0, is_deleted: true },
        ]),
    ) === "[5]",
);

// --- Duplicate-label detection (no unique key to lean on) ----------------------------------------

const LABEL_ROWS = [ALPHA_DEFAULT, BETA, REMOVED_ALPHA];

check("duplicate label: an exact live match is found", duplicateLabelRow(LABEL_ROWS, "Beta")?.id === 2);
check("duplicate label: a trimmed, case-only variant is still a duplicate", duplicateLabelRow(LABEL_ROWS, "  beta ")?.id === 2);
check("duplicate label: a fresh label is free", duplicateLabelRow(LABEL_ROWS, "Delta") === null);
check("duplicate label: a row may keep its own label on update", duplicateLabelRow(LABEL_ROWS, "Alpha", 1) === null);
check(
    "duplicate label: a soft-deleted row never blocks reusing its label",
    duplicateLabelRow(LABEL_ROWS, "Alpha", 1) === null && duplicateLabelRow([REMOVED_ALPHA], "Alpha") === null,
);

// --- Default fallback (a missing flag must never strand task creation) ---------------------------

check("default fallback: the flagged row wins over a lower unflagged one", effectiveDefaultRow([BETA, FLAGGED_HIGH])?.id === 7);
check("default fallback: with no flag, the lowest (sort_order, id) live row is used", effectiveDefaultRow([GAMMA, BETA, { ...ALPHA_DEFAULT, is_default: 0 }])?.id === 1);
check("default fallback: a sort_order tie resolves to the lower id", effectiveDefaultRow([TIE_LATE, TIE_EARLY])?.id === 4);
check("default fallback: a kind with a flag missing still resolves", effectiveDefaultRow([BETA, GAMMA])?.id === 2);
check("default fallback: soft-deleted rows never serve as the default", effectiveDefaultRow([REMOVED_ALPHA, BETA])?.id === 2);
check(
    "default fallback: two flagged rows resolve deterministically to the lower id",
    effectiveDefaultRow([{ ...BETA, is_default: 1 }, ALPHA_DEFAULT])?.id === 1,
);
check("default fallback: an empty kind has no default", effectiveDefaultRow([]) === null);
check("default fallback: an all-soft-deleted kind has no default", effectiveDefaultRow([REMOVED_ALPHA]) === null);

// --- Soft-delete guard ---------------------------------------------------------------------------

const TWO_LIVE = [ALPHA_DEFAULT, BETA];
const TWO_UNFLAGGED = [{ ...ALPHA_DEFAULT, is_default: 0 }, BETA];

check("delete guard: the current default row is refused", deleteRefusal(TWO_LIVE, 1) === "current-default");
check("delete guard: a non-default row of a two-row kind is allowed", deleteRefusal(TWO_LIVE, 2) === null);
check(
    "delete guard: a missing flag still protects the effective (fallback) default",
    deleteRefusal(TWO_UNFLAGGED, 1) === "current-default",
);
check("delete guard: the fallback default's sibling may be removed", deleteRefusal(TWO_UNFLAGGED, 2) === null);
check("delete guard: the last live row of a kind is refused", deleteRefusal([ALPHA_DEFAULT], 1) === "last-live-row");
check(
    "delete guard: a soft-deleted sibling does not count as live",
    deleteRefusal([ALPHA_DEFAULT, REMOVED_ALPHA], 1) === "last-live-row",
);
check("delete guard: an absent id is not-found", deleteRefusal(TWO_LIVE, 99) === "not-found");
check("delete guard: an id that is only soft-deleted is not-found", deleteRefusal(TWO_LIVE, 9) === "not-found");

// --- Completion percent (status catalog only) ----------------------------------------------------

/** Minimal shapes for the resolution hook — `@types/node` 20 has no `registerHooks` to infer from. */
type ResolveContext = { readonly conditions: readonly string[]; readonly parentURL?: string };
type ResolveNext = (specifier: string, context?: ResolveContext) => { url: string };

/**
 * `task-config.schema` imports the icon allow-list without a file extension: the bundler resolves
 * that, Node does not. The hook retries such a specifier as `.ts`, which is the only way to load the
 * real schema module — and therefore the real validators — under plain Node.
 */
registerHooks({
    resolve(specifier: string, context: ResolveContext, nextResolve: ResolveNext): { url: string } {
        try {
            return nextResolve(specifier, context);
        } catch (error) {
            // A specifier such as "../types/task-config.schema" carries no extension at all, while
            // "../x.schema" only looks like it does; appending ".ts" is the one retry that fits both.
            if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
            throw error;
        }
    },
});

// @ts-expect-error -- Node needs the real ".ts" extension; tsc forbids it (see the file header).
const { CreateCatalogItemSchema, UpdateCatalogItemSchema } = await import("../types/task-config.schema.ts");

/** The first issue message a payload produces, or `null` when it is accepted. */
function firstIssueMessage(value: unknown): string | null {
    const parsed = CreateCatalogItemSchema.safeParse({ label: "Alpha", completion_percent: value });
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? "");
}

check(
    "completion percent: the bounds 0 and 100 are accepted",
    CreateCatalogItemSchema.safeParse({ label: "Alpha", completion_percent: 0 }).success &&
        CreateCatalogItemSchema.safeParse({ label: "Alpha", completion_percent: 100 }).success,
);

const OMITTED_PERCENT = CreateCatalogItemSchema.parse({ label: "Alpha" });
check(
    "completion percent: omitting it is valid, leaves the key absent and reads as 0",
    !("completion_percent" in OMITTED_PERCENT) && (OMITTED_PERCENT.completion_percent ?? 0) === 0,
);

check("completion percent: 101 is rejected with a range message", firstIssueMessage(101) === "Completion percent must be between 0 and 100");
check("completion percent: -1 is rejected with a range message", firstIssueMessage(-1) === "Completion percent must be between 0 and 100");
check("completion percent: a fraction is rejected with a whole-number message", firstIssueMessage(1.5) === "Completion percent must be a whole number");
check("completion percent: a numeric string is rejected, not coerced", firstIssueMessage("50") !== null);
check("completion percent: the update schema inherits the field and stays fully optional", UpdateCatalogItemSchema.safeParse({ completion_percent: 100 }).success);

// --- Coded error ---------------------------------------------------------------------------------

const refusal = new TaskConfigError("VALIDATION_FAILED", "a live row already uses that label");
check(
    "TaskConfigError carries its code and a CODE-prefixed message",
    refusal instanceof Error && refusal.code === "VALIDATION_FAILED" && refusal.message.startsWith("VALIDATION_FAILED:"),
    refusal.message,
);

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

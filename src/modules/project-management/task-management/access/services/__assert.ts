/**
 * Phase-A assertion harness for the assignment-grant policy.
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/task-management/access/services/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * The predicates in `./grant-policy` are the exact functions the grant service calls, so the
 * revive-or-insert decision, the live-only grant state, the tolerant flag reader and the department
 * `allow_all_members_grant` policy (absent row = ON) are asserted without a database. Why the `.ts`
 * extension and the directive: Node resolves a relative import only
 * when the specifier carries the real file extension, while `tsc` rejects a `.ts` specifier unless
 * `allowImportingTsExtensions` is on — and the project `tsconfig.json` (a protected scaffold file
 * this module may not edit) does not enable it. The directive suppresses only that extension
 * complaint; the module is still fully resolved and typed by `tsc`, so `npx tsc --noEmit` stays
 * green alongside this Node run.
 *
 * The fixtures below deliberately include the soft-deleted row and the Buffer-shaped flag that the
 * live Directus answers with: those two shapes are exactly what the revive path depends on.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { GrantError, UNGRANTED_STATE, DEFAULT_ALLOW_ALL_MEMBERS_GRANT, findExistingGrantRow, findExistingSettingRow, grantStateByUserId, isTrueFlag, liveGrantRows, mergeMemberGrantState, resolveAllowAllMembersGrant, toPhTimestamp, toPositiveInt } from "./grant-policy.ts";

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

// --- Fixture grant rows (ids are arbitrary; the shapes are the point) ---------------------------

const GRANT_HEAD = { id: 11, user_id: 177, is_deleted: 0, granted_by: 176 };
const GRANT_REVOKED = { id: 12, user_id: 178, is_deleted: 1, granted_by: 176 };
const GRANT_STRING = { id: 13, user_id: "262", is_deleted: "0", granted_by: "176" };
const GRANT_BUFFER_LIVE = { id: 14, user_id: 263, is_deleted: { type: "Buffer", data: [0] }, granted_by: 176 };
const GRANT_BUFFER_REVOKED = { id: 15, user_id: 281, is_deleted: { type: "Buffer", data: [1] }, granted_by: 176 };
const GRANT_OUTSIDER = { id: 16, user_id: 999, is_deleted: 0, granted_by: 176 };
const GRANT_DUPLICATE_LATE = { id: 21, user_id: 177, is_deleted: 0, granted_by: 176 };
const GRANT_DUPLICATE_EARLY = { id: 20, user_id: 177, is_deleted: 0, granted_by: 176 };

// --- Flag reading (the live `user.is_deleted` answers as a Buffer JSON object) -------------------

check("flag: a number 1 is true", isTrueFlag(1));
check("flag: a number 0 is false", !isTrueFlag(0));
check("flag: a boolean true is true", isTrueFlag(true));
check('flag: the strings "0" and "false" are false', !isTrueFlag("0") && !isTrueFlag("false"));
check('flag: the string "1" is true', isTrueFlag("1"));
check("flag: a byte array holding 1 is true", isTrueFlag(new Uint8Array([1])));
check("flag: a byte array holding the ASCII 1 is true", isTrueFlag(new Uint8Array([0x31])));
check("flag: a byte array holding 0 is false", !isTrueFlag(new Uint8Array([0])));
check(
    'flag: the Buffer JSON shape the live user table answers with reads 0 as false',
    !isTrueFlag({ type: "Buffer", data: [0] }),
);
check(
    "flag: a Buffer-shaped 1 is true (a deleted member must not be listed)",
    isTrueFlag({ type: "Buffer", data: [1] }),
);
check("flag: null, undefined, an empty object and an array are all false", [null, undefined, {}, []].every((value) => !isTrueFlag(value)));

// --- The department assignment-grant policy ------------------------------------------------------

check("setting: the default constant is ON", DEFAULT_ALLOW_ALL_MEMBERS_GRANT === true);
check(
    "setting: an ABSENT row resolves ON (why no department needs a backfill)",
    resolveAllowAllMembersGrant([]) === true,
);
check(
    "setting: a present row with the flag set is ON and with the flag clear is OFF",
    resolveAllowAllMembersGrant([{ allow_all_members_grant: 1 }]) === true
        && resolveAllowAllMembersGrant([{ allow_all_members_grant: 0 }]) === false,
);
check(
    "setting: string-shaped flags are read",
    resolveAllowAllMembersGrant([{ allow_all_members_grant: "0" }]) === false
        && resolveAllowAllMembersGrant([{ allow_all_members_grant: "1" }]) === true,
);
check(
    "setting: Buffer-shaped flags are read",
    resolveAllowAllMembersGrant([{ allow_all_members_grant: { type: "Buffer", data: [0] } }]) === false
        && resolveAllowAllMembersGrant([{ allow_all_members_grant: { type: "Buffer", data: [1] } }]) === true,
);
check(
    "setting: a present row with an unreadable flag is OFF (a row is authoritative, only absence defaults ON)",
    resolveAllowAllMembersGrant([{ allow_all_members_grant: null }]) === false,
);
check(
    "setting revive decision: a soft-deleted row is still found (that is the revive path)",
    findExistingSettingRow([{ id: 12, is_deleted: 1 }])?.id === 12,
);
check("setting revive decision: no row means INSERT", findExistingSettingRow([]) === null);
check(
    "setting revive decision: duplicates resolve deterministically to the lowest id",
    findExistingSettingRow([{ id: 21 }, { id: 20 }])?.id === 20,
);

// --- Id normalisation ----------------------------------------------------------------------------

check("toPositiveInt: a number passes through", toPositiveInt(7) === 7);
check("toPositiveInt: a string-shaped id is parsed", toPositiveInt("7") === 7);
check("toPositiveInt: zero, negatives, fractions and junk resolve to null", [0, -1, 1.5, "abc", "", null, undefined, {}].every((value) => toPositiveInt(value) === null));

// --- Timestamp normalisation ---------------------------------------------------------------------

check("timestamp: a Directus T-separated DATETIME is normalised", toPhTimestamp("2026-09-17T14:13:17") === "2026-09-17 14:13:17");
check("timestamp: the module wire shape is left untouched", toPhTimestamp("2026-09-17 14:13:17") === "2026-09-17 14:13:17");
check("timestamp: anything that is not a string resolves to null", [null, undefined, 123, {}].every((value) => toPhTimestamp(value) === null));

// --- Live-row reading ----------------------------------------------------------------------------

check(
    "liveGrantRows keeps a live row and drops a revoked one",
    JSON.stringify(liveGrantRows([GRANT_HEAD, GRANT_REVOKED]).map((row) => row.id)) === "[11]",
);
check(
    "liveGrantRows reads string-shaped and Buffer-shaped flags",
    JSON.stringify(liveGrantRows([GRANT_STRING, GRANT_BUFFER_LIVE, GRANT_BUFFER_REVOKED]).map((row) => row.id)) === "[13,14]",
);

// --- The revive-or-insert decision ---------------------------------------------------------------

check("revive decision: a SOFT-DELETED row is still found (that is the revive path)", findExistingGrantRow([GRANT_HEAD, GRANT_REVOKED], 178)?.id === 12);
check("revive decision: no row for this member means INSERT", findExistingGrantRow([GRANT_HEAD, GRANT_REVOKED], 179) === null);
check("revive decision: another member's row is never the target", findExistingGrantRow([GRANT_HEAD], 999) === null);
check("revive decision: a string-shaped user id still matches", findExistingGrantRow([GRANT_STRING], 262)?.id === 13);
check(
    "revive decision: duplicates resolve deterministically to the lowest id",
    findExistingGrantRow([GRANT_DUPLICATE_LATE, GRANT_DUPLICATE_EARLY], 177)?.id === 20,
);

// --- Active-grant state --------------------------------------------------------------------------

const STATE = grantStateByUserId([GRANT_HEAD, GRANT_REVOKED, GRANT_STRING, GRANT_BUFFER_LIVE, GRANT_BUFFER_REVOKED, GRANT_OUTSIDER]);

check("state: a live row is granted with its row id and provenance", STATE.get(177)?.grant_id === 11 && STATE.get(177)?.granted_by === 176 && STATE.get(177)?.is_granted === true);
check("state: a REVOKED row carries no active state", STATE.get(178) === undefined);
check("state: a Buffer-shaped live row is granted", STATE.get(263)?.grant_id === 14);
check("state: a Buffer-shaped revoked row carries no active state", STATE.get(281) === undefined);
check("state: a string-shaped granted_by is normalised to a number", STATE.get(262)?.granted_by === 176);
check("state: every live row is represented once", STATE.size === 4);
check("state: an empty grant table yields no state", grantStateByUserId([]).size === 0);
check("ungranted state is the all-negative default", UNGRANTED_STATE.is_granted === false && UNGRANTED_STATE.grant_id === null && UNGRANTED_STATE.granted_by === null);

// --- The member list join ------------------------------------------------------------------------

const MEMBERS = [
    { user_id: 176, is_deleted: 0, user_fname: "Probe", user_lname: "Head" },
    { user_id: 177, is_deleted: 0, user_fname: "Probe", user_lname: "Granted" },
    { user_id: 178, is_deleted: 0, user_fname: "Probe", user_lname: "Revoked" },
    { user_id: 179, is_deleted: 1, user_fname: "Probe", user_lname: "Removed" },
    { user_id: 180, is_deleted: { type: "Buffer", data: [1] }, user_fname: "Probe", user_lname: "BufferRemoved" },
];

const MERGED = mergeMemberGrantState(MEMBERS, [GRANT_HEAD, GRANT_REVOKED, GRANT_OUTSIDER]);

check(
    "merge: soft-deleted members are excluded (number and Buffer shapes)",
    JSON.stringify(MERGED.map((member) => member.user_id)) === "[176,177,178]",
);
check("merge: the input order is preserved", MERGED[0].user_lname === "Head" && MERGED[2].user_lname === "Revoked");
check("merge: an un-granted member reads as not granted", MERGED[0].is_granted === false && MERGED[0].grant_id === null);
check("merge: a live grant reads back its row id and provenance", MERGED[1].is_granted === true && MERGED[1].grant_id === 11 && MERGED[1].granted_by === 176);
check("merge: a revoked grant reads as not granted", MERGED[2].is_granted === false && MERGED[2].grant_id === null);
check("merge: a grant row for a user outside the member set is never surfaced", MERGED.every((member) => member.user_id !== 999));
check("merge: member fields ride along with the grant state", MERGED[1].user_fname === "Probe" && MERGED[1].user_lname === "Granted");
check("merge: an empty grant table leaves every member un-granted", mergeMemberGrantState(MEMBERS, []).every((member) => !member.is_granted));

// --- Coded error ---------------------------------------------------------------------------------

const refusal = new GrantError("NOT_FOUND", "No live member with that user id exists in your department");
check(
    "GrantError carries its code and a CODE-prefixed message",
    refusal instanceof Error && refusal.code === "NOT_FOUND" && refusal.message.startsWith("NOT_FOUND:"),
    refusal.message,
);

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);

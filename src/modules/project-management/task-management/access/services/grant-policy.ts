/**
 * The pure core of the assignment-grant policy.
 *
 * `pm_task_assigner` carries `UNIQUE (department_id, user_id)`, and that key ignores `is_deleted`.
 * Two consequences decide every write, and both are total functions here so they can be asserted
 * without a database:
 *
 * - every re-grant path MUST revive the existing row rather than insert another one, or the INSERT
 *   raises a duplicate-key error — `findExistingGrantRow` is that revive-or-insert decision, searched
 *   over live AND soft-deleted rows;
 * - the member list's "active grant" state reads LIVE rows only, so a revoked row reads as "not
 *   granted" while the row itself survives, exactly so the next grant can revive it —
 *   `grantStateByUserId` / `mergeMemberGrantState` are that join.
 *
 * `isTrueFlag` reads a `TINYINT(1)` in every shape this Directus instance answers with. That is not
 * defensive decoration: the live `user.is_deleted` column answers as the Node-Buffer JSON shape
 * `{ type: "Buffer", data: [0] }`, so a predicate that understood only numbers would quietly list
 * soft-deleted members. `pm_task_assigner.is_deleted` is written by this module and answers as a
 * plain number, but it is read through the same total function.
 *
 * The department's `allow_all_members_grant` policy is resolved here too: `resolveAllowAllMembersGrant`
 * turns the department's setting rows into the boolean the permission matrix consumes, with an
 * ABSENT row meaning ON — the owner's default for every department, needing no backfill.
 *
 * This file imports nothing and uses only erasable syntax (no enum, no namespace, no parameter
 * properties) so `services/__assert.ts` can load it through Node's native type stripping — the same
 * arrangement `department-scope.ts` and `permission-matrix.ts` have with the services harness.
 */

/**
 * The minimum a `pm_task_assigner` row must expose to be judged. `unknown` on the runtime-shaped
 * fields on purpose: a row coming from Directus is shaped at runtime (a flag can be a number, a
 * string, a boolean or a Buffer), and the predicates must stay total for every shape.
 */
export interface GrantRow {
    readonly id: number;
    readonly user_id: unknown;
    readonly is_deleted: unknown;
    readonly granted_by?: unknown;
}

/** The minimum a department member row must expose to be joined with its grant state. */
export interface GrantMemberRow {
    readonly user_id: unknown;
    readonly is_deleted: unknown;
}

/** A member's active-grant state — one row of the grant list. */
export interface MemberGrantState {
    /** A LIVE `pm_task_assigner` row exists for this member in this department. */
    readonly is_granted: boolean;
    /** The live grant row's id (the value a revoke names), or `null` when not granted. */
    readonly grant_id: number | null;
    /** The user id recorded in `granted_by` — provenance, or `null`. */
    readonly granted_by: number | null;
}

/** The coded failure kinds the grant service throws. Routes map NOT_FOUND to 404, else 500. */
export type GrantErrorCode = "NOT_FOUND" | "INTERNAL_FAIL";

/** A grant-policy refusal, carrying the `CODE: message` shape conventions section 13 pins. */
export class GrantError extends Error {
    readonly code: GrantErrorCode;

    constructor(code: GrantErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "GrantError";
        this.code = code;
    }
}

/** The Node-Buffer JSON shape this Directus instance answers with for its binary integer columns. */
interface BufferJson {
    readonly type: "Buffer";
    readonly data: readonly number[];
}

/** Narrowing guard for the `{ type: "Buffer", data: [...] }` payload shape. */
function isBufferJson(value: unknown): value is BufferJson {
    if (typeof value !== "object" || value === null) return false;
    if (!("type" in value) || !("data" in value)) return false;
    return value.type === "Buffer" && Array.isArray(value.data);
}

/** A byte counts as true when it is `1` or its ASCII form (`0x31`, the character "1"). */
function isTrueByte(byte: number): boolean {
    return byte === 1 || byte === 0x31;
}

/**
 * Reads a `TINYINT(1)` flag in every shape this Directus instance answers with: `true` and non-zero
 * numbers are true; `0`, `"0"` and `"false"` are false; a byte array holding `1` or its ASCII form is
 * true, whether it arrives as a real `Uint8Array` or as the Buffer JSON shape the live `user` table
 * returns. Anything else — including `null` and `undefined` — is false.
 */
export function isTrueFlag(value: unknown): boolean {
    if (value === true) return true;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
    if (value instanceof Uint8Array) return value.some(isTrueByte);
    if (isBufferJson(value)) return value.data.some(isTrueByte);
    return false;
}

/**
 * Normalises a Directus `DATETIME` onto the module's wire shape.
 *
 * Directus serialises a MySQL `DATETIME` as `2026-09-17T14:13:17` — the stored wall clock with an
 * ISO separator. The module's contract is the `YYYY-MM-DD HH:mm:ss` shape the timestamps were
 * written in (`phNow()`), and the `T` form is easy to mistake for a UTC conversion, so it is
 * replaced here. This is the same normalisation `tasks/services/task-payload.ts` applies — that one
 * is private to its own feature, so the three lines live here too rather than coupling this module
 * to another feature's internals. The instant is untouched: no zone is applied in either direction.
 */
export function toPhTimestamp(value: unknown): string | null {
    return typeof value === "string" ? value.replace("T", " ") : null;
}

/** Normalises a Directus id-ish value to a positive integer; anything else resolves to `null`. */
export function toPositiveInt(value: unknown): number | null {
    if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
}

/** The live (not soft-deleted) grant rows of the given set. */
export function liveGrantRows<T extends GrantRow>(rows: readonly T[]): T[] {
    return rows.filter((row) => !isTrueFlag(row.is_deleted));
}

/**
 * The existing grant row for this member — INCLUDING a soft-deleted one — which is the
 * revive-or-insert decision: a hit means the grant revives with a PATCH, a miss means INSERT.
 *
 * `uq_pm_assigner (department_id, user_id)` makes the row unique, so a hit can only ever be the row
 * the unique key already owns; if duplicates ever slipped past it, the lowest id wins so the
 * decision stays deterministic.
 */
export function findExistingGrantRow<T extends GrantRow>(rows: readonly T[], userId: number): T | null {
    let match: T | null = null;
    for (const row of rows) {
        if (toPositiveInt(row.user_id) !== userId) continue;
        if (match === null || row.id < match.id) match = row;
    }
    return match;
}

/** The state of a member with no live grant row. */
export const UNGRANTED_STATE: MemberGrantState = {
    is_granted: false,
    grant_id: null,
    granted_by: null,
};

/**
 * The active-grant state per member id, LIVE rows only: a revoked (soft-deleted) row reads as "not
 * granted" here while staying findable by `findExistingGrantRow` for the revive path. A malformed
 * row id or user id is skipped rather than guessed at.
 */
export function grantStateByUserId(rows: readonly GrantRow[]): Map<number, MemberGrantState> {
    const states = new Map<number, MemberGrantState>();
    const live = [...liveGrantRows(rows)].sort((a, b) => a.id - b.id);

    for (const row of live) {
        const userId = toPositiveInt(row.user_id);
        if (userId === null || states.has(userId)) continue;
        states.set(userId, {
            is_granted: true,
            grant_id: row.id,
            granted_by: toPositiveInt(row.granted_by),
        });
    }
    return states;
}

/**
 * The default a department's assignment-grant policy resolves to when no setting row exists yet:
 * ON, so every department — existing ones included — starts with granting open to all members and
 * needs no backfill or migration. `pm_task_department_setting` carries `DEFAULT 1` too, so the
 * stored default and the resolved default agree.
 */
export const DEFAULT_ALLOW_ALL_MEMBERS_GRANT = true;

/** The minimum a `pm_task_department_setting` row must expose to be judged. */
export interface DepartmentSettingRow {
    readonly allow_all_members_grant: unknown;
}

/**
 * Resolves a department's `allow_all_members_grant` policy from its LIVE setting rows (at most one,
 * `uq_pm_dept_setting (department_id)`).
 *
 * An ABSENT row is ON — the owner's explicit default for every department, which is why no
 * backfill and no migration exist for this table. A present row is read through `isTrueFlag`, so
 * the flag is understood in every shape Directus answers with rather than only as a number.
 */
export function resolveAllowAllMembersGrant(rows: readonly DepartmentSettingRow[]): boolean {
    const row = rows[0];
    if (row === undefined) return DEFAULT_ALLOW_ALL_MEMBERS_GRANT;
    return isTrueFlag(row.allow_all_members_grant);
}

/**
 * The existing setting row for a department — INCLUDING a soft-deleted one — which is the
 * revive-or-insert decision for the write path: `uq_pm_dept_setting (department_id)` ignores
 * `is_deleted`, so a blind INSERT after a soft delete would raise a duplicate-key error. If
 * duplicates ever slipped past the unique key, the lowest id wins so the decision stays
 * deterministic.
 */
export function findExistingSettingRow<T extends { readonly id: number }>(rows: readonly T[]): T | null {
    let match: T | null = null;
    for (const row of rows) {
        if (match === null || row.id < match.id) match = row;
    }
    return match;
}

/**
 * Joins the department's member rows with the department's grant rows: every returned member carries
 * its active-grant state, and a soft-deleted member is dropped entirely. A grant row for a user who
 * is not among the members contributes nothing, so the list can never surface an outsider — the
 * department filter on both queries is what keeps another department's users out; this join is what
 * keeps the state honest.
 */
export function mergeMemberGrantState<M extends GrantMemberRow>(
    members: readonly M[],
    grants: readonly GrantRow[],
): Array<M & MemberGrantState> {
    const states = grantStateByUserId(grants);
    const merged: Array<M & MemberGrantState> = [];

    for (const member of members) {
        if (isTrueFlag(member.is_deleted)) continue;
        const userId = toPositiveInt(member.user_id);
        const state = userId === null ? UNGRANTED_STATE : states.get(userId) ?? UNGRANTED_STATE;
        merged.push({ ...member, ...state });
    }

    return merged;
}

/**
 * The access service — the department-scoped policy of *who may edit this department's tasks*.
 *
 * A `pm_task_access` row is the whole grant: one row means this member may edit tasks (which includes
 * assigning, setting status and priority, changing dates and custom fields) and configure the
 * department's catalogs; no row means they may only work on tasks they created. Granting is available
 * to the head and to any member while the department policy is ON — `assertCanGrant` decides, and
 * the routes use the same evaluator, so a caller cannot reach the write paths around it. The service
 * additionally refuses to grant a user who is not a live member of the actor's own department.
 *
 * Two rules shape every call:
 *
 * 1. `UNIQUE (department_id, user_id)` exists, and it ignores `is_deleted`. A blind INSERT after a
 *    revoke raises a duplicate-key error, so `grant` is REVIVE-OR-INSERT: it looks the row up
 *    INCLUDING soft-deleted rows and PATCHes `is_deleted: 0` when one is found, inserting only when
 *    there is none. `findExistingAccessRow` (the pure core) makes that decision.
 *    (The index is still literally named `uq_pm_assigner` — MySQL's `RENAME TABLE` renames the table,
 *    not its indexes. Only its name is stale; the constraint is the one described here.)
 * 2. Every read and every write carries `department_id = actor.departmentId`. A grant row is never
 *    visible, revivable or revocable across departments, and a cross-department target user is a
 *    404 — never a 403 — so another department's membership is never confirmed.
 *
 * Audit columns (`granted_by`, `created_at`, `created_by`, `updated_at`, `updated_by`) are injected
 * server-side from the actor in Philippine time; no client input reaches them. The revive path
 * deliberately keeps the original `granted_by` (the instruction's contract) and records the reviving
 * head in `updated_by`.
 *
 * Every table access goes through `withAccessTable`, which resolves the collection name at runtime
 * and self-heals if it changes under a running process — see `./access-table`.
 */

import { createItem, readItems, updateItem } from "@/modules/project-management/services/directus-client";
import { assertCanGrant } from "@/modules/project-management/services/permission-service";
import type { ScopedActor } from "@/modules/project-management/services/actor-service";
import { phNow } from "@/modules/project-management/utils/ph-time";
import type { GrantAccessInput } from "../types/access.schema";
import { withAccessTable } from "./access-table";
import { AccessError, findExistingAccessRow, isTrueFlag, mergeMemberAccessState, toPhTimestamp, toPositiveInt, type AccessRow } from "./access-policy";

export {
    AccessError,
    UNGRANTED_STATE,
    findExistingAccessRow,
    accessStateByUserId,
    isTrueFlag,
    liveAccessRows,
    mergeMemberAccessState,
    toPhTimestamp,
    toPositiveInt,
} from "./access-policy";
export type { AccessErrorCode, AccessMemberRow, AccessRow, MemberAccessState } from "./access-policy";

/**
 * A `user` directory row as this service reads it. `is_deleted` stays `unknown` because the live
 * column answers as a Buffer-shaped flag — see `isTrueFlag`.
 */
interface UserDirectoryRow {
    readonly user_id: number;
    readonly user_fname: string | null;
    readonly user_lname: string | null;
    readonly user_email: string | null;
    readonly is_deleted: unknown;
}

/** A `pm_task_access` row as this service reads it. The table carries no foreign keys by design —
 * `department_id`, `user_id` and `granted_by` are attribution, so they are read as plain integers.
 */
export interface ScopedAccessRow extends AccessRow {
    readonly id: number;
    readonly department_id: number;
    readonly user_id: number;
    readonly granted_by: number | null;
    readonly is_deleted: number;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
}

/** One row of the access list: a department member plus their active-access state. */
export interface MemberAccessRow {
    readonly user_id: number;
    readonly user_fname: string | null;
    readonly user_lname: string | null;
    readonly user_email: string | null;
    readonly is_granted: boolean;
    /** The live grant row's id — the value a revoke names — or `null` when not granted. */
    readonly grant_id: number | null;
    /** The user id recorded when the grant was issued (provenance), or `null`. */
    readonly granted_by: number | null;
    /**
     * True when this row is the actor themselves. The roster still lists them — they are a member —
     * but the grant picker excludes them, because nobody grants themselves access.
     */
    readonly is_self: boolean;
}

export class AccessService {
    /**
     * The actor's department members, each with their active-access state — the access list's data.
     *
     * Both queries are department-filtered, so the result can only ever contain this department's
     * users and this department's grants; a soft-deleted member is dropped by the pure join, and a
     * revoked grant simply reads as `is_granted: false` (the row itself is kept for revival).
     */
    static async listMembers(actor: ScopedActor): Promise<MemberAccessRow[]> {
        const [members, grants] = await Promise.all([
            readItems<UserDirectoryRow>("user", {
                filter: { user_department: { _eq: actor.departmentId } },
                fields: ["user_id", "user_fname", "user_lname", "user_email", "is_deleted"],
                sort: ["user_fname", "user_lname"],
                limit: -1,
            }),
            AccessService.listGrantRows(actor),
        ]);

        return mergeMemberAccessState(members, grants).map((member) => ({
            user_id: member.user_id,
            user_fname: member.user_fname,
            user_lname: member.user_lname,
            user_email: member.user_email,
            is_granted: member.is_granted,
            grant_id: member.grant_id,
            granted_by: member.granted_by,
            is_self: member.user_id === actor.userId,
        }));
    }

    /**
     * Grants a live member of the actor's own department Edit access, via `assertCanGrant` — the head
     * always may, and any member may while the department policy is ON.
     *
     * REVIVE-OR-INSERT: the existing row is looked up including soft-deleted ones (the unique key
     * makes at most one), and a hit is patched back to `is_deleted: 0` rather than re-inserted — a
     * blind INSERT after a revoke would raise a duplicate-key error. The INSERT path records
     * `granted_by`; both paths record the actor in `updated_by` and write Philippine time.
     */
    static async grant(actor: ScopedActor, input: GrantAccessInput): Promise<ScopedAccessRow> {
        await assertCanGrant(actor);

        // Nobody grants themselves. The picker already hides the actor, but this is the authoritative
        // refusal: it also closes the "bank a row while the policy is ON" path, because a grant row
        // outlives the policy — a self-issued one would survive the policy being switched OFF.
        if (input.user_id === actor.userId) {
            throw new AccessError(
                "VALIDATION_FAILED",
                "You cannot grant Edit access to yourself",
            );
        }

        await AccessService.requireDepartmentMember(actor, input.user_id);

        const existing = await AccessService.readGrantRowsForUser(actor, input.user_id);
        const row = findExistingAccessRow(existing, input.user_id);
        const now = phNow();

        if (row !== null) {
            await withAccessTable((table) =>
                updateItem<unknown>(table, row.id, {
                    is_deleted: 0,
                    updated_at: now,
                    updated_by: actor.userId,
                }),
            );
            return AccessService.toWireRow({ ...row, is_deleted: 0, updated_at: now, updated_by: actor.userId });
        }

        await withAccessTable((table) =>
            createItem<unknown>(table, {
                department_id: actor.departmentId,
                user_id: input.user_id,
                granted_by: actor.userId,
                is_deleted: 0,
                created_at: now,
                created_by: actor.userId,
                updated_at: now,
                updated_by: actor.userId,
            }),
        );

        return AccessService.readActiveGrant(actor, input.user_id);
    }

    /**
     * Revokes a grant — always a soft delete, never a hard one — head-only via `assertCanGrant`.
     *
     * The grant row is loaded with `department_id = actor.departmentId` (and live), so another
     * department's grant id is a 404 and its row is left untouched. The row survives with
     * `is_deleted: 1` precisely so the next grant can revive it.
     */
    static async revoke(actor: ScopedActor, grantId: string | number): Promise<ScopedAccessRow> {
        await assertCanGrant(actor);

        const id = toPositiveInt(grantId);
        if (id === null) {
            throw new AccessError("NOT_FOUND", "No live grant with that id exists in your department");
        }

        const rows = await withAccessTable((table) =>
            readItems<ScopedAccessRow>(table, {
                filter: {
                    id: { _eq: id },
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: 1,
            }),
        );

        const row = rows[0];
        if (row === undefined) {
            throw new AccessError("NOT_FOUND", "No live grant with that id exists in your department");
        }

        const now = phNow();
        await withAccessTable((table) =>
            updateItem<unknown>(table, row.id, {
                is_deleted: 1,
                updated_at: now,
                updated_by: actor.userId,
            }),
        );
        return AccessService.toWireRow({ ...row, is_deleted: 1, updated_at: now, updated_by: actor.userId });
    }

    /** Projects a raw Directus row onto the module's wire shape: `T`-separated DATETIMEs normalised. */
    private static toWireRow(row: ScopedAccessRow): ScopedAccessRow {
        return { ...row, created_at: toPhTimestamp(row.created_at), updated_at: toPhTimestamp(row.updated_at) };
    }

    /** The department's grant rows, live only — the list join's second half. */
    private static async listGrantRows(actor: ScopedActor): Promise<ScopedAccessRow[]> {
        return withAccessTable((table) =>
            readItems<ScopedAccessRow>(table, {
                filter: {
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: -1,
            }),
        );
    }

    /**
     * The department's grant rows for one member, INCLUDING soft-deleted rows — the revive lookup.
     * The unique key makes at most one row; the pure predicate still resolves deterministically.
     */
    private static async readGrantRowsForUser(actor: ScopedActor, userId: number): Promise<ScopedAccessRow[]> {
        return withAccessTable((table) =>
            readItems<ScopedAccessRow>(table, {
                filter: {
                    department_id: { _eq: actor.departmentId },
                    user_id: { _eq: userId },
                },
                limit: -1,
            }),
        );
    }

    /**
     * The live grant row just written, read back — Directus may answer a mutation with 204 No
     * Content, so the read is how the generated id and the stored audit fields are learned.
     */
    private static async readActiveGrant(actor: ScopedActor, userId: number): Promise<ScopedAccessRow> {
        const rows = await withAccessTable((table) =>
            readItems<ScopedAccessRow>(table, {
                filter: {
                    department_id: { _eq: actor.departmentId },
                    user_id: { _eq: userId },
                    is_deleted: { _eq: 0 },
                },
                limit: 1,
            }),
        );

        const row = rows[0];
        if (row === undefined) {
            throw new AccessError("INTERNAL_FAIL", "The grant row was written but could not be read back");
        }
        return AccessService.toWireRow(row);
    }

    /**
     * Resolves the grant target from the actor's own department only, and refuses a soft-deleted
     * member. A miss is a 404 by design: whether the user does not exist, is soft-deleted, or belongs
     * to another department is deliberately indistinguishable.
     */
    private static async requireDepartmentMember(actor: ScopedActor, userId: number): Promise<UserDirectoryRow> {
        const rows = await readItems<UserDirectoryRow>("user", {
            filter: {
                user_id: { _eq: userId },
                user_department: { _eq: actor.departmentId },
            },
            fields: ["user_id", "user_fname", "user_lname", "user_email", "is_deleted"],
            limit: 1,
        });

        const member = rows[0];
        if (member === undefined || isTrueFlag(member.is_deleted)) {
            throw new AccessError("NOT_FOUND", "No live member with that user id exists in your department");
        }
        return member;
    }
}

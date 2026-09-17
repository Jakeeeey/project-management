import { DirectusRequestError, createItem, readItems, updateItem } from "@/modules/project-management/services/directus-client";
import type { ScopedActor } from "@/modules/project-management/services/actor-service";
import { phNow } from "@/modules/project-management/utils/ph-time";
import type { UpdateDepartmentSettingInput } from "../types/access.schema";
import { findExistingSettingRow, resolveAllowAllMembersGrant } from "./access-policy";

/**
 * The department-setting service behind the "Allow all members Edit access" toggle.
 *
 * `pm_task_department_setting` holds one row per department (`uq_pm_dept_setting (department_id)`)
 * and today carries exactly one decision: `allow_all_members_grant`. The service's whole job is to
 * resolve that decision for the permission evaluator and to store changes to it.
 *
 * The rule that makes this table need no migration: **an absent row means ON** — the owner's default
 * for every department, existing ones included. `resolveAllowAllMembersGrant` owns that decision, and
 * both the read path and the evaluator resolve through it, so they can never disagree.
 *
 * Scoping: every read and every write carries `department_id = actor.departmentId` — the department
 * is never taken from a request body or a URL. `is_deleted` is always `0` on the read path; the write
 * path deliberately reads INCLUDING soft-deleted rows and revives rather than inserting, because the
 * unique key ignores `is_deleted` (a blind INSERT after a soft delete raises a duplicate-key error).
 *
 * The HEAD-ONLY capability check is NOT here: `assertCanManageDepartmentSetting` lives in the
 * permission evaluator and the route calls it before this service. Keeping that assertion out of
 * this file is what lets the evaluator import this service without a cycle.
 */

/** The collection this service owns. */
const SETTING_COLLECTION = "pm_task_department_setting";

/**
 * A `pm_task_department_setting` row as this service reads it. The flag stays `unknown` because a
 * `TINYINT(1)` arrives in several run-time shapes — see `isTrueFlag` in `./access-policy`.
 */
export interface ScopedSettingRow {
    readonly id: number;
    readonly department_id: number;
    readonly allow_all_members_grant: unknown;
    readonly is_deleted: unknown;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
}

/** The wire shape of the department policy: the resolved flag, absent-row default already applied. */
export interface DepartmentSetting {
    readonly allow_all_members_grant: boolean;
}

export class DepartmentSettingService {
    /**
     * The resolved policy for the actor's department, as the permission matrix consumes it.
     *
     * An absent (or soft-deleted) row resolves to ON — the owner's default for every department — so
     * this returns a plain boolean and never `null`.
     */
    static async resolveAllowAllMembersGrant(actor: ScopedActor): Promise<boolean> {
        const row = await DepartmentSettingService.readLiveRow(actor);
        return resolveAllowAllMembersGrant(row === null ? [] : [row]);
    }

    /** The policy for the actor's department, in the shape the route's `setting` field returns. */
    static async getSetting(actor: ScopedActor): Promise<DepartmentSetting> {
        return { allow_all_members_grant: await DepartmentSettingService.resolveAllowAllMembersGrant(actor) };
    }

    /**
     * Stores a new policy value for the actor's department and returns the resolved policy.
     *
     * REVIVE-OR-INSERT: `uq_pm_dept_setting (department_id)` ignores `is_deleted`, so the existing
     * row is looked up INCLUDING soft-deleted ones and patched back to `is_deleted: 0` when found;
     * the INSERT path creates the department's first row. `department_id` and every audit column are
     * injected from the actor here — no client input reaches them — and the timestamp is Philippine
     * time via `phNow()`.
     */
    static async updateSetting(actor: ScopedActor, input: UpdateDepartmentSettingInput): Promise<DepartmentSetting> {
        const existing = await DepartmentSettingService.readAnyRow(actor);
        const now = phNow();
        const flag = input.allow_all_members_grant ? 1 : 0;

        if (existing !== null) {
            await updateItem<unknown>(SETTING_COLLECTION, existing.id, {
                allow_all_members_grant: flag,
                is_deleted: 0,
                updated_at: now,
                updated_by: actor.userId,
            });
            return { allow_all_members_grant: input.allow_all_members_grant };
        }

        await createItem<unknown>(SETTING_COLLECTION, {
            department_id: actor.departmentId,
            allow_all_members_grant: flag,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });
        return { allow_all_members_grant: input.allow_all_members_grant };
    }

    /**
     * The department's live setting row, if it has one.
     *
     * An unavailable collection resolves to "no row", not an error: the evaluator resolves this policy
     * on every capability check, so a propagated 403/404 would 500 every task, configuration and grants
     * route until the owner runs the DDL. A missing table therefore falls back to the absent-row
     * default (ON), and only a toggle change cannot persist. Any other status still throws.
     */
    private static async readLiveRow(actor: ScopedActor): Promise<ScopedSettingRow | null> {
        try {
            const rows = await readItems<ScopedSettingRow>(SETTING_COLLECTION, {
                filter: {
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: 1,
            });
            return rows[0] ?? null;
        } catch (error: unknown) {
            DepartmentSettingService.rethrowUnlessCollectionUnavailable(error);
            return null;
        }
    }

    /** The department's setting row INCLUDING a soft-deleted one — the revive-or-insert lookup. */
    private static async readAnyRow(actor: ScopedActor): Promise<ScopedSettingRow | null> {
        try {
            const rows = await readItems<ScopedSettingRow>(SETTING_COLLECTION, {
                filter: {
                    department_id: { _eq: actor.departmentId },
                },
                limit: -1,
            });
            return findExistingSettingRow(rows);
        } catch (error: unknown) {
            DepartmentSettingService.rethrowUnlessCollectionUnavailable(error);
            return null;
        }
    }

    /** Swallows an unavailable-collection status (403/404); anything else is rethrown. */
    private static rethrowUnlessCollectionUnavailable(error: unknown): void {
        if (error instanceof DirectusRequestError && (error.status === 403 || error.status === 404)) {
            console.error(
                `[access setting] ${SETTING_COLLECTION} is unavailable (status ${error.status}); ` +
                    "falling back to the absent-row default. Run the change-2 DDL and register the collection in Directus.",
            );
            return;
        }
        throw error;
    }
}

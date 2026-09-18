/**
 * The permission evaluator — the one place this module decides what an actor may do.
 *
 * The authorization inputs are exactly three data rows, never a role string: the actor's own
 * `department` row (already read into `actor.isDepartmentHead` by `resolveActor()`), a live
 * `pm_task_access` row, and the department's `pm_task_department_setting` policy (an absent row
 * means ON). Capability flags are never taken from client input.
 *
 * One matrix, two entry points:
 * - `getPermissionContext(actor)` — resolve once per request. It returns the eight coarse flags,
 *   the row-aware `canEditThisTask(task)` and `canDeleteThisTask(task)`, and `capabilitiesForClient()`
 *   for the route payload.
 * - the `assertCan*` helpers — the same matrix, throwing `PermissionError` (code `FORBIDDEN`).
 *
 * The row-aware answers are why this evaluator exists rather than a bag of booleans: a member who
 * created a task may always finish it, so "may edit THIS task" cannot be a session flag. Both
 * `assertCanEdit` and every row's `can_edit` payload go through `canEditThisTask`, and `assertCanDelete`
 * and every row's `can_delete` through `canDeleteThisTask`, so the UI and the server can never
 * disagree about the same row.
 *
 * Granting and changing the policy were the same question while granting was head-only; they are two
 * now, and the two must not be conflated:
 * - `assertCanGrant` admits the head AND any member while the department policy is ON — it gates
 *   handing out Edit access, which members may do when the toggle is open.
 * - `assertCanManageDepartmentSetting` is HEAD-ONLY and gates the toggle itself, so a member who may
 *   grant can never open or close the right they were given.
 *
 * The pure matrix lives in `./permission-matrix` (zero imports, Phase-A assertable) and is
 * re-exported here so this file presents the full evaluator surface.
 */

import { readItems } from "./directus-client";
import { DepartmentSettingService } from "./department-setting-service";
import { withAccessTable } from "./access-table";
import type { ScopedActor } from "./actor-service";
import type { Capabilities } from "../types/capabilities";
import { PermissionError, allows, canDeleteTaskFrom, canEditTaskFrom, type RoleFacts } from "./permission-matrix";

export {
    PermissionError,
    allows,
    canAssignFrom,
    canConfigureFrom,
    canDeleteFrom,
    canDeleteTaskFrom,
    canEditFrom,
    canEditTaskFrom,
    canGrantFrom,
    canManageSettingFrom,
} from "./permission-matrix";
export type { Capability, RoleFacts, TaskRowFacts } from "./permission-matrix";

/**
 * The minimum a task row must expose for a row-aware answer. `unknown` on purpose: the row arrives
 * from Directus, where an `INT` can be shaped as number, string or null, and the comparison must
 * stay total for every shape instead of trusting one.
 */
export interface TaskCreatorRow {
    readonly created_by: unknown;
}

/**
 * The resolved evaluator for one actor in one request. The eight flags mirror the Permission
 * Matrix; the two methods carry the answers that cannot be plain flags.
 */
export interface PermissionContext extends Capabilities {
    /**
     * The authoritative per-row edit answer (head, granted member, or the task's creator). This is
     * the exact predicate `assertCanEdit` enforces, so a route must not re-derive it.
     */
    canEditThisTask(task: TaskCreatorRow): boolean;
    /**
     * The authoritative per-row delete answer (head, granted member, or the task's creator).
     * This is the exact predicate `assertCanDelete` enforces, so a route must not re-derive it.
     */
    canDeleteThisTask(task: TaskCreatorRow): boolean;
    /** The wire payload: the eight coarse flags only, never the row-aware methods. */
    capabilitiesForClient(): Capabilities;
}

/** The one access fact this evaluator reads. */
interface AccessGrantRow {
    readonly id: number;
}

/**
 * Normalises a Directus-shaped `INT` to a user id; anything that cannot be one resolves to `null`,
 * so a missing or malformed creator never equals an actor.
 */
function toUserId(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const userId = Number(value);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
}

/**
 * "Does an active access grant exist for this actor in their own department?"
 *
 * The filter carries the department as well as the user, so a grant issued in another department
 * can never widen an actor's capabilities here. Headship is separate and implicit — see
 * `getPermissionContext`.
 *
 * The table name is resolved at runtime (`./access-table`) because the grant table was renamed and a
 * deployment can be on either side of that DDL; reading the wrong name would 403 and 500 every
 * capability check on every route. `withAccessTable` also re-resolves if the name changes under a
 * running process, so a rename needs no restart.
 */
async function hasActiveGrant(actor: ScopedActor): Promise<boolean> {
    const rows = await withAccessTable((table) =>
        readItems<AccessGrantRow>(table, {
            filter: {
                department_id: { _eq: actor.departmentId },
                user_id: { _eq: actor.userId },
                is_deleted: { _eq: 0 },
            },
            fields: ["id"],
            limit: 1,
        }),
    );
    return rows.length > 0;
}

/**
 * Resolves the actor's capabilities for this request. The actor is a `ScopedActor`, so a session
 * without a department cannot reach the evaluator at all — the route answers 403 first.
 */
export async function getPermissionContext(actor: ScopedActor): Promise<PermissionContext> {
    const [hasGrant, allowAllMembersGrant] = await Promise.all([
        hasActiveGrant(actor),
        DepartmentSettingService.resolveAllowAllMembersGrant(actor),
    ]);

    const facts: RoleFacts = {
        isHead: actor.isDepartmentHead,
        hasGrant,
        allowAllMembersGrant,
    };

    const capabilities: Capabilities = {
        canView: allows("view", facts),
        canCreate: allows("create", facts),
        canEdit: allows("edit", facts),
        canAssign: allows("assign", facts),
        canDelete: allows("delete", facts),
        canGrant: allows("grant", facts),
        canConfigure: allows("configure", facts),
        canManageDepartmentSetting: allows("manage-setting", facts),
    };

    return {
        ...capabilities,
        canEditThisTask: (task: TaskCreatorRow): boolean =>
            canEditTaskFrom({ ...facts, isCreator: toUserId(task.created_by) === actor.userId }),
        canDeleteThisTask: (task: TaskCreatorRow): boolean =>
            canDeleteTaskFrom({ ...facts, isCreator: toUserId(task.created_by) === actor.userId }),
        capabilitiesForClient: (): Capabilities => ({ ...capabilities }),
    };
}

/** Creates a task. Every member of the department may; kept as an assert for the route contract. */
export async function assertCanCreate(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canCreate) {
        throw new PermissionError("FORBIDDEN: Creating a task requires a resolved department");
    }
}

/**
 * Edits a task's fields. ROW-AWARE: head or granted member, otherwise the task's creator — a member
 * who raised a task can always finish it, but a plain member working on someone else's task cannot.
 * Calls `canEditThisTask`, the same predicate that computes the row's `can_edit` payload.
 */
export async function assertCanEdit(actor: ScopedActor, task: TaskCreatorRow): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canEditThisTask(task)) {
        throw new PermissionError(
            "FORBIDDEN: Editing this task requires Edit access, or being its creator",
        );
    }
}

/**
 * Moves (reorders or re-parents) a task. The matrix defines this as `edit`, so this is the same
 * row-aware predicate as `assertCanEdit` — the move route must never grow an independent gate.
 */
export async function assertCanMove(actor: ScopedActor, task: TaskCreatorRow): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canEditThisTask(task)) {
        throw new PermissionError(
            "FORBIDDEN: Moving this task requires Edit access, or being its creator",
        );
    }
}

/**
 * Deletes a task. Row-aware: head or granted member, otherwise the task's creator. Calls
 * `canDeleteThisTask`, the same predicate that computes the row's `can_delete` payload.
 */
export async function assertCanDelete(actor: ScopedActor, task: TaskCreatorRow): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canDeleteThisTask(task)) {
        throw new PermissionError(
            "FORBIDDEN: Deleting this task requires Edit access, or being its creator",
        );
    }
}

/** Assigns or unassigns. Head (implicitly) or a granted member only. */
export async function assertCanAssign(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canAssign) {
        throw new PermissionError("FORBIDDEN: Assigning a task requires Edit access");
    }
}

/**
 * Grants or revokes Edit access. The head always may; every member may while the department's
 * `allow_all_members_grant` policy is ON (the default). This is NOT the guard for the toggle itself
 * — see `assertCanManageDepartmentSetting`, which is head-only.
 */
export async function assertCanGrant(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canGrant) {
        throw new PermissionError(
            "FORBIDDEN: Granting Edit access requires the department head or an open department policy",
        );
    }
}

/**
 * Changes the department's access policy (the "allow all members to grant" toggle). HEAD-ONLY,
 * always: the head must be able to turn the policy OFF while it is ON, and a member who may
 * currently grant — because the policy is ON — must never be able to change that policy.
 */
export async function assertCanManageDepartmentSetting(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canManageDepartmentSetting) {
        throw new PermissionError(
            "FORBIDDEN: Changing the department's access policy is limited to the department head",
        );
    }
}

/** Edits the status / priority catalog and the custom columns. Head or a granted member. */
export async function assertCanConfigure(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canConfigure) {
        throw new PermissionError(
            "FORBIDDEN: Editing the task configuration requires Edit access",
        );
    }
}

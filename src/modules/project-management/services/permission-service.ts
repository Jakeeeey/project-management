/**
 * The permission evaluator — the one place this module decides what an actor may do.
 *
 * The authorization inputs are exactly two data rows, never a role string: the actor's own
 * `department` row (already read into `actor.isDepartmentHead` by `resolveActor()`) and a live
 * `pm_task_assigner` row. Capability flags are never taken from client input.
 *
 * One matrix, two entry points:
 * - `getPermissionContext(actor)` — resolve once per request. It returns the seven coarse flags,
 *   the row-aware `canDeleteThisTask(task)`, and `capabilitiesForClient()` for the route payload.
 * - the `assertCan*` helpers — the same matrix, throwing `PermissionError` (code `FORBIDDEN`).
 *
 * `assertCanDelete(actor, task)` and every row's `can_delete` payload both go through
 * `canDeleteThisTask`, so the UI and the server can never disagree about the same row.
 *
 * The pure matrix lives in `./permission-matrix` (zero imports, Phase-A assertable) and is
 * re-exported here so this file presents the full evaluator surface.
 */

import { readItems } from "./directus-client";
import type { ScopedActor } from "./actor-service";
import type { Capabilities } from "../types/capabilities";
import { PermissionError, allows, canDeleteTaskFrom, type RoleFacts } from "./permission-matrix";

export { PermissionError, allows, canAssignFrom, canConfigureFrom, canDeleteFrom, canDeleteTaskFrom, canGrantFrom } from "./permission-matrix";
export type { Capability, DeleteFacts, RoleFacts } from "./permission-matrix";

/**
 * The minimum a task row must expose for the row-aware delete answer. `unknown` on purpose: the row
 * arrives from Directus, where an `INT` can be shaped as number, string or null, and the
 * comparison must stay total for every shape instead of trusting one.
 */
export interface TaskCreatorRow {
    readonly created_by: unknown;
}

/**
 * The resolved evaluator for one actor in one request. The seven flags mirror the Permission
 * Matrix; the two methods carry the answers that cannot be plain flags.
 */
export interface PermissionContext extends Capabilities {
    /**
     * The authoritative per-row delete answer (head, granted assigner, or the task's creator).
     * This is the exact predicate `assertCanDelete` enforces, so a route must not re-derive it.
     */
    canDeleteThisTask(task: TaskCreatorRow): boolean;
    /** The wire payload: the seven coarse flags only, never the row-aware method. */
    capabilitiesForClient(): Capabilities;
}

/** The one grant fact this evaluator reads. */
interface AssignerGrantRow {
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
 * "Does an active assigner grant exist for this actor in their own department?"
 *
 * The filter carries the department as well as the user, so a grant issued in another department
 * can never widen an actor's capabilities here. Headship is separate and implicit — see
 * `getPermissionContext`.
 */
async function hasActiveGrant(actor: ScopedActor): Promise<boolean> {
    const rows = await readItems<AssignerGrantRow>("pm_task_assigner", {
        filter: {
            department_id: { _eq: actor.departmentId },
            user_id: { _eq: actor.userId },
            is_deleted: { _eq: 0 },
        },
        fields: ["id"],
        limit: 1,
    });
    return rows.length > 0;
}

/**
 * Resolves the actor's capabilities for this request. The actor is a `ScopedActor`, so a session
 * without a department cannot reach the evaluator at all — the route answers 403 first.
 */
export async function getPermissionContext(actor: ScopedActor): Promise<PermissionContext> {
    const facts: RoleFacts = {
        isHead: actor.isDepartmentHead,
        hasGrant: await hasActiveGrant(actor),
    };

    const capabilities: Capabilities = {
        canView: allows("view", facts),
        canCreate: allows("create", facts),
        canEdit: allows("edit", facts),
        canAssign: allows("assign", facts),
        canDelete: allows("delete", facts),
        canGrant: allows("grant", facts),
        canConfigure: allows("configure", facts),
    };

    return {
        ...capabilities,
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

/** Edits a task's fields. Every member of the department may. */
export async function assertCanEdit(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canEdit) {
        throw new PermissionError("FORBIDDEN: Editing a task requires the edit capability");
    }
}

/**
 * Moves (reorders or re-parents) a task. The matrix defines this as `canEdit`, so this is the same
 * predicate as `assertCanEdit` — the move route must never grow an independent gate.
 */
export async function assertCanMove(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canEdit) {
        throw new PermissionError("FORBIDDEN: Moving a task requires the edit capability, which is the same as editing");
    }
}

/**
 * Deletes a task. Row-aware: head or granted assigner, otherwise the task's creator. Calls
 * `canDeleteThisTask`, the same predicate that computes the row's `can_delete` payload.
 */
export async function assertCanDelete(actor: ScopedActor, task: TaskCreatorRow): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canDeleteThisTask(task)) {
        throw new PermissionError("FORBIDDEN: Deleting this task requires headship, an assigner grant, or being its creator");
    }
}

/** Assigns or unassigns. Head (implicitly) or a granted assigner only. */
export async function assertCanAssign(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canAssign) {
        throw new PermissionError("FORBIDDEN: Assigning a task requires headship or a granted assigner right");
    }
}

/** Grants or revokes assigner rights. Head-only — a granted assigner can never grant. */
export async function assertCanGrant(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canGrant) {
        throw new PermissionError("FORBIDDEN: Granting assigner rights is limited to the department head");
    }
}

/** Edits the status / priority catalog. Head or a granted assigner (the plan's recorded coupling). */
export async function assertCanConfigure(actor: ScopedActor): Promise<void> {
    const permissions = await getPermissionContext(actor);
    if (!permissions.canConfigure) {
        throw new PermissionError("FORBIDDEN: Editing the status or priority catalog requires headship or a granted assigner right");
    }
}

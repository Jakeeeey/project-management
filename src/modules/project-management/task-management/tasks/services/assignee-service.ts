import { createItem, readItems, updateItem } from "@/modules/project-management/services/directus-client";
import type { ScopedActor } from "@/modules/project-management/services/actor-service";
import type { ScopedTaskRow } from "@/modules/project-management/services/scoping";
import { phNow } from "@/modules/project-management/utils/ph-time";
import type { AssigneeMutationInput } from "../types/pm-task.schema";
import { TaskServiceError } from "./task-service";
import { isDeletedFlag, toNumberOrNull, toPhTimestamp } from "./task-payload";

/**
 * The assignees service — who is working on a task of the actor's department.
 *
 * A `pm_task_assignee` row is the whole assignment: one row per `(task_id, user_id)`, soft-deleted
 * when the member is taken off the task. Two rules shape every call:
 *
 * 1. `uq_pm_task_assignee (task_id, user_id)` exists, and it ignores `is_deleted`. A blind INSERT
 *    after an unassign raises a duplicate-key error, so `assign` is REVIVE-OR-INSERT: it looks the
 *    row up INCLUDING soft-deleted rows — keyed by exactly the pair the unique key owns — and
 *    PATCHes `is_deleted: 0` when one is found, inserting only when there is none.
 * 2. The task is already department-scoped by the route (`loadTaskScoped`) and the target user must
 *    be a live member of that same department, so no caller can assign, revive or unassign a row
 *    belonging to another department. A target that is absent, soft-deleted or foreign is a 404 —
 *    never a 403 — so another department's membership is never confirmed.
 *
 * Audit columns (`department_id`, `created_at`, `created_by`, `updated_at`, `updated_by`) are
 * injected server-side from the actor in Philippine time; no client input reaches them. The revive
 * path deliberately keeps the original `created_at` / `created_by` — the row is revived, not
 * recreated — and records the actor in `updated_by`.
 */

/** The one collection an assignment row lives in. */
const ASSIGNEE_COLLECTION = "pm_task_assignee";

/**
 * A `pm_task_assignee` row as Directus returns it. The audit fields stay `unknown` on purpose: a
 * `TINYINT(1)` can arrive as a number, a boolean, a string or the Buffer JSON shape, and a
 * `DATETIME` arrives with a `T` separator — the wire projection normalises both rather than
 * trusting one shape.
 */
interface RawAssigneeRow {
    readonly id: number;
    readonly task_id: number;
    readonly user_id: number;
    readonly department_id: number;
    readonly is_deleted: unknown;
    readonly created_at: unknown;
    readonly created_by: unknown;
    readonly updated_at: unknown;
    readonly updated_by: unknown;
}

/** An assignment row as the route hands it to the module's UI. */
export interface AssigneeWireRow {
    readonly id: number;
    readonly task_id: number;
    readonly user_id: number;
    readonly department_id: number;
    readonly is_deleted: number;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
}

/**
 * A `user` directory row as this service reads it. `is_deleted` stays `unknown` because the live
 * `user.is_deleted` column answers as the Buffer-shaped flag `{ type: "Buffer", data: [0] }`, so a
 * numbers-only check would silently accept a soft-deleted member.
 */
interface UserDirectoryRow {
    readonly user_id: number;
    readonly is_deleted: unknown;
}

/** Projects a raw Directus row onto the wire shape: the flag becomes 0/1 and `T`-dates are normalised. */
function toWireRow(row: RawAssigneeRow): AssigneeWireRow {
    return {
        id: row.id,
        task_id: row.task_id,
        user_id: row.user_id,
        department_id: row.department_id,
        is_deleted: isDeletedFlag(row.is_deleted) ? 1 : 0,
        created_at: toPhTimestamp(row.created_at),
        created_by: toNumberOrNull(row.created_by),
        updated_at: toPhTimestamp(row.updated_at),
        updated_by: toNumberOrNull(row.updated_by),
    };
}

export class AssigneeService {
    /**
     * Assigns a live member of the actor's own department to the task — REVIVE-OR-INSERT.
     *
     * The target is resolved from the `user` table scoped to `user_department = actor.departmentId`
     * and must not be soft-deleted; a miss is a 404 (absent, deleted and foreign are deliberately
     * indistinguishable). The existing row is then looked up INCLUDING a soft-deleted one: a hit is
     * patched back to `is_deleted: 0` (the unique key ignores `is_deleted`, so a blind INSERT would
     * raise a duplicate-key error), a miss is the only case that inserts. Both paths write
     * Philippine time and record the actor in `updated_by`.
     */
    static async assign(
        actor: ScopedActor,
        task: ScopedTaskRow,
        input: AssigneeMutationInput,
    ): Promise<AssigneeWireRow> {
        await AssigneeService.requireDepartmentMember(actor, input.user_id);

        const existing = await AssigneeService.readReviveCandidate(task.id, input.user_id);
        const now = phNow();

        if (existing !== null) {
            await updateItem<unknown>(ASSIGNEE_COLLECTION, existing.id, {
                is_deleted: 0,
                updated_at: now,
                updated_by: actor.userId,
            });
            return toWireRow({ ...existing, is_deleted: 0, updated_at: now, updated_by: actor.userId });
        }

        await createItem<unknown>(ASSIGNEE_COLLECTION, {
            task_id: task.id,
            user_id: input.user_id,
            department_id: actor.departmentId,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });

        return toWireRow(await AssigneeService.readLiveRow(actor, task.id, input.user_id));
    }

    /**
     * Takes a member off the task — always a soft delete, never a hard one — so the row survives
     * with `is_deleted: 1` and the next `assign` can revive it.
     *
     * The row is loaded with `task_id`, `user_id`, `department_id = actor.departmentId` and
     * `is_deleted = 0`, so a miss — never assigned, already unassigned, or another department's —
     * is a 404 and leaves every row untouched. The target's current membership is deliberately not
     * re-checked: a member who has since left the department, or was soft-deleted, must still be
     * removable from the task.
     */
    static async unassign(
        actor: ScopedActor,
        task: ScopedTaskRow,
        input: AssigneeMutationInput,
    ): Promise<AssigneeWireRow> {
        const rows = await readItems<RawAssigneeRow>(ASSIGNEE_COLLECTION, {
            filter: {
                task_id: { _eq: task.id },
                user_id: { _eq: input.user_id },
                department_id: { _eq: actor.departmentId },
                is_deleted: { _eq: 0 },
            },
            limit: 1,
        });

        const row = rows[0];
        if (row === undefined) {
            throw new TaskServiceError("NOT_FOUND", "This user is not assigned to the task");
        }

        const now = phNow();
        await updateItem<unknown>(ASSIGNEE_COLLECTION, row.id, {
            is_deleted: 1,
            updated_at: now,
            updated_by: actor.userId,
        });
        return toWireRow({ ...row, is_deleted: 1, updated_at: now, updated_by: actor.userId });
    }

    /**
     * The existing `(task_id, user_id)` row — INCLUDING a soft-deleted one — which is the
     * revive-or-insert decision: a hit means the assignment revives with a PATCH, a miss is the
     * only case that inserts.
     *
     * The lookup mirrors `uq_pm_task_assignee (task_id, user_id)` exactly and carries no
     * `is_deleted` or `department_id` clause on purpose: the unique key knows neither, so filtering
     * either one out and then inserting would collide with a row the database still owns and raise
     * a duplicate-key 500. The task is already department-scoped by the route and the target user
     * is verified a live member of the same department, so the pair can only name a row this
     * department already owns. Should duplicates ever slip past the key, the lowest id wins so the
     * decision stays deterministic.
     */
    private static async readReviveCandidate(taskId: number, userId: number): Promise<RawAssigneeRow | null> {
        const rows = await readItems<RawAssigneeRow>(ASSIGNEE_COLLECTION, {
            filter: {
                task_id: { _eq: taskId },
                user_id: { _eq: userId },
            },
            limit: -1,
        });

        let candidate: RawAssigneeRow | null = null;
        for (const row of rows) {
            if (candidate === null || row.id < candidate.id) candidate = row;
        }
        return candidate;
    }

    /**
     * The live assignment just written, read back — Directus may answer a mutation with 204 No
     * Content, so the read is how the generated id and the stored audit fields are learned.
     */
    private static async readLiveRow(actor: ScopedActor, taskId: number, userId: number): Promise<RawAssigneeRow> {
        const rows = await readItems<RawAssigneeRow>(ASSIGNEE_COLLECTION, {
            filter: {
                task_id: { _eq: taskId },
                user_id: { _eq: userId },
                department_id: { _eq: actor.departmentId },
                is_deleted: { _eq: 0 },
            },
            limit: 1,
        });

        const row = rows[0];
        if (row === undefined) {
            throw new TaskServiceError("INTERNAL_FAIL", "The assignment was written but could not be read back");
        }
        return row;
    }

    /**
     * Resolves the assignment target from the actor's own department only, and refuses a
     * soft-deleted member. A miss is a 404 by design: whether the user does not exist, is
     * soft-deleted, or belongs to another department is deliberately indistinguishable.
     */
    private static async requireDepartmentMember(actor: ScopedActor, userId: number): Promise<void> {
        const rows = await readItems<UserDirectoryRow>("user", {
            filter: {
                user_id: { _eq: userId },
                user_department: { _eq: actor.departmentId },
            },
            fields: ["user_id", "is_deleted"],
            limit: 1,
        });

        const member = rows[0];
        if (member === undefined || isDeletedFlag(member.is_deleted)) {
            throw new TaskServiceError("NOT_FOUND", "No live member with that user id exists in your department");
        }
    }
}

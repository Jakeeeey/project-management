import { readItems, updateItem, updateItems } from "@/modules/project-management/services/directus-client";
import type { ScopedActor } from "@/modules/project-management/services/actor-service";
import type { PermissionContext } from "@/modules/project-management/services/permission-service";
import { loadTaskScoped, type ScopedAttachmentRow, type ScopedTaskRow } from "@/modules/project-management/services/scoping";
import { TaskConfigService } from "@/modules/project-management/task-configuration/services/task-config-service";
import { collectDescendantIds, type TreeSourceRow } from "@/modules/project-management/utils/tree";
import { phNow } from "@/modules/project-management/utils/ph-time";
import type { UpdateTaskInput } from "../types/pm-task.schema";
import { TaskServiceError, assertDateOrder, resolveCatalogId } from "./task-service";
import {
    buildShaping,
    liveNestedRows,
    toClientRow,
    toNumberOrNull,
    type RawTaskRow,
    type TaskAssigneeRow,
    type TaskClientRow,
} from "./task-payload";

/**
 * The task item service — one task of the actor's department, read, edited, or soft-deleted with
 * its whole subtree.
 *
 * Every method receives a row the route already loaded through `loadTaskScoped`, so the department
 * guard has run and a miss has already become a 404 before anything here executes.
 *
 * Three rules are shared with the collection service rather than re-implemented: the wire row
 * projects through `task-payload.toClientRow` (so the detail payload's `can_delete` and resolved
 * catalog labels are the same computation the list returns), a supplied catalog id resolves through
 * `resolveCatalogId` (the create path's rule), and the start/end pair through `assertDateOrder`.
 *
 * The cascade delete is deliberately NOT transactional — Directus has no multi-statement
 * transaction. It is ordered leaf-first: descendants are collected deepest-first and written in one
 * bulk `PATCH`, and only then is the subject row hidden. A mid-flight failure can therefore only
 * hide rows beneath a still-visible parent, never orphan a live child under a deleted parent, and a
 * retry converges. A partial failure is raised as an error and never reported as success.
 */

/** The subtree a cascade delete hid, as the route returns it. */
export interface DeletedTaskSubtree {
    readonly id: number;
    readonly deleted_ids: readonly number[];
}

/** The `YYYY-MM-DD` prefix of a stored `DATE`, which Directus may serialise with a time part. */
function toDateOnly(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return value.slice(0, 10);
}

/**
 * Copies a supplied field into the change set only when it actually differs from the stored column.
 * `undefined` means "not supplied" and is never written; `null` is a real value (clearing a date),
 * so it is compared as `null` rather than skipped.
 */
function applyChange(changes: Record<string, unknown>, field: string, value: unknown, stored: unknown): void {
    if (value === undefined) return;
    if ((value ?? null) === (stored ?? null)) return;
    changes[field] = value;
}

/** Projects a scoped row onto the payload row shape `toClientRow` reads. */
function toPayloadRow(row: ScopedTaskRow): RawTaskRow {
    return {
        id: row.id,
        department_id: row.department_id,
        parent_id: row.parent_id,
        status_id: row.status_id,
        priority_id: row.priority_id,
        title: row.title,
        description: row.description,
        start_date: row.start_date,
        end_date: row.end_date,
        sort_order: row.sort_order,
        created_at: row.created_at,
        created_by: row.created_by,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
    };
}

export class TaskItemService {
    /**
     * One task in the wire shape the list route uses: the stored columns, the live nested
     * assignees/attachments, the labels resolved from live catalog rows only, and the
     * server-computed `can_delete`.
     */
    static async readTask(
        actor: ScopedActor,
        permissions: PermissionContext,
        task: ScopedTaskRow,
    ): Promise<TaskClientRow> {
        const [catalogs, assignees, attachments] = await Promise.all([
            TaskConfigService.listCatalog(actor),
            readItems<TaskAssigneeRow>("pm_task_assignee", {
                filter: {
                    task_id: { _eq: task.id },
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: -1,
            }),
            readItems<ScopedAttachmentRow>("pm_task_attachment", {
                filter: {
                    task_id: { _eq: task.id },
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: -1,
            }),
        ]);

        return toClientRow(
            {
                row: toPayloadRow(task),
                assignees: liveNestedRows<TaskAssigneeRow>(assignees),
                attachments: liveNestedRows<ScopedAttachmentRow>(attachments),
            },
            buildShaping(catalogs, permissions),
        );
    }

    /**
     * Applies an `UpdateTaskSchema` body to one live task, writing only the fields that actually
     * changed plus `updated_at` / `updated_by`.
     *
     * The end/start order is checked on the **merged** pair, so a one-sided PATCH cannot invert the
     * range against the stored other end. A supplied catalog id is validated against the actor's
     * live department catalogs only when it differs from the stored value, so a task still pointing
     * at a since-soft-deleted status can be edited without its dangling reference blocking the
     * write. A body that changes nothing performs no write and returns the current row.
     */
    static async updateTask(
        actor: ScopedActor,
        permissions: PermissionContext,
        task: ScopedTaskRow,
        input: UpdateTaskInput,
    ): Promise<TaskClientRow> {
        const mergedStart = toDateOnly(input.start_date === undefined ? task.start_date : input.start_date);
        const mergedEnd = toDateOnly(input.end_date === undefined ? task.end_date : input.end_date);
        assertDateOrder(mergedStart, mergedEnd);

        const changes: Record<string, unknown> = {};
        applyChange(changes, "title", input.title, task.title);
        applyChange(changes, "description", input.description, task.description);
        applyChange(changes, "start_date", input.start_date, toDateOnly(task.start_date));
        applyChange(changes, "end_date", input.end_date, toDateOnly(task.end_date));

        const statusChanged = input.status_id !== undefined && input.status_id !== task.status_id;
        const priorityChanged = input.priority_id !== undefined && input.priority_id !== task.priority_id;
        if (statusChanged || priorityChanged) {
            const catalogs = await TaskConfigService.listCatalog(actor);
            if (statusChanged) {
                const statusId = resolveCatalogId(catalogs.statuses, input.status_id, "status");
                if (statusId !== task.status_id) changes.status_id = statusId;
            }
            if (priorityChanged) {
                const priorityId = resolveCatalogId(catalogs.priorities, input.priority_id, "priority");
                if (priorityId !== task.priority_id) changes.priority_id = priorityId;
            }
        }

        if (Object.keys(changes).length === 0) return TaskItemService.readTask(actor, permissions, task);

        await updateItem<unknown>("pm_task", task.id, {
            ...changes,
            updated_at: phNow(),
            updated_by: actor.userId,
        });

        const updated = await loadTaskScoped(actor, task.id);
        if (updated === null) {
            throw new TaskServiceError("INTERNAL_FAIL", "The task was updated but could not be read back");
        }
        return TaskItemService.readTask(actor, permissions, updated);
    }

    /**
     * Soft-deletes one task and every descendant — never a hard delete.
     *
     * Descendants are written in one bulk `PATCH` ordered deepest-first, and only after that
     * succeeds is the subject row hidden. A failure anywhere raises `TaskServiceError` so the route
     * answers with an error envelope: a retry converges, and the leaf-first order guarantees the
     * worst partial state is rows hidden beneath a still-visible parent.
     */
    static async deleteTaskSubtree(actor: ScopedActor, task: ScopedTaskRow): Promise<DeletedTaskSubtree> {
        const descendants = collectDescendantIds(await TaskItemService.readDepartmentTreeRows(actor), task.id);

        const audit = { is_deleted: 1, updated_at: phNow(), updated_by: actor.userId };
        try {
            if (descendants.length > 0) {
                await updateItems<unknown>(
                    "pm_task",
                    descendants.map((id) => ({ id, ...audit })),
                );
            }
            await updateItem<unknown>("pm_task", task.id, audit);
        } catch (error) {
            console.error(
                `[tasks DELETE] the cascade for task ${task.id} failed after attempting ${descendants.length} descendant(s); the subtree may be partially hidden:`,
                error,
            );
            throw new TaskServiceError(
                "INTERNAL_FAIL",
                "The task subtree could not be fully deleted; retry the delete to finish it",
            );
        }

        return { id: task.id, deleted_ids: [task.id, ...descendants] };
    }

    /**
     * The department's live rows reduced to the adjacency-list shape the tree helpers read.
     * `id`/`parent_id`/`sort_order` are normalised because a `BIGINT` can arrive as a string.
     *
     * Shared with the move route: its cycle guard and its completeness rule both need the whole
     * live department as one flat set, exactly as the cascade delete does.
     */
    static async readDepartmentTreeRows(actor: ScopedActor): Promise<TreeSourceRow[]> {
        const rows = await readItems<{
            readonly id?: unknown;
            readonly parent_id?: unknown;
            readonly sort_order?: unknown;
        }>("pm_task", {
            filter: { department_id: { _eq: actor.departmentId }, is_deleted: { _eq: 0 } },
            fields: ["id", "parent_id", "sort_order"],
            limit: -1,
        });

        const treeRows: TreeSourceRow[] = [];
        for (const row of rows) {
            const id = toNumberOrNull(row.id);
            if (id === null) continue;
            treeRows.push({
                id,
                parent_id: toNumberOrNull(row.parent_id),
                sort_order: toNumberOrNull(row.sort_order) ?? 0,
            });
        }
        return treeRows;
    }
}

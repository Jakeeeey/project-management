import { readItems, updateItem, updateItems } from "./directus-client";
import type { ScopedActor } from "./actor-service";
import type { PermissionContext } from "./permission-service";
import { loadTaskScoped, type ScopedAttachmentRow, type ScopedTaskRow } from "./scoping";
import { TaskConfigService } from "@/modules/project-management/task-management/configure/services/task-config-service";
import { collectDescendantIds, type TreeSourceRow } from "../utils/tree";
import { phNow } from "../utils/ph-time";
import type { UpdateTaskInput } from "../types/pm-task.schema";
import { TaskServiceError, assertDateOrder, resolveCatalogId } from "./task-service";
import { TaskFieldService } from "./task-field-service";
import {
    TASK_ACTIVITY_FIELD_LABELS,
    buildActivityChange,
    catalogLabelOf,
    formatActivityValue,
    type TaskActivityChange,
} from "./task-activity-delta";
import { TaskActivityService } from "./task-activity-service";
import {
    buildShaping,
    liveFieldValues,
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
        list_id: row.list_id,
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
        const [catalogs, assignees, attachments, values, fields] = await Promise.all([
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
            TaskFieldService.listValuesFor(actor, task.id),
            TaskFieldService.listEnabledFields(actor),
        ]);

        return toClientRow(
            {
                row: toPayloadRow(task),
                assignees: liveNestedRows<TaskAssigneeRow>(assignees),
                attachments: liveNestedRows<ScopedAttachmentRow>(attachments),
                values: liveFieldValues(values, fields),
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
     *
     * `list_id` is immutable here: a supplied value that differs from the stored one is a 400, so a
     * plain edit can never move a task — and with it half a subtree — into another list. Re-parenting
     * is the move route's job and it refuses a cross-list target for the same reason.
     */
    static async updateTask(
        actor: ScopedActor,
        permissions: PermissionContext,
        task: ScopedTaskRow,
        input: UpdateTaskInput,
    ): Promise<TaskClientRow> {
        const storedListId = toNumberOrNull(task.list_id);
        if (input.list_id !== undefined && (input.list_id ?? null) !== storedListId) {
            throw new TaskServiceError(
                "VALIDATION_FAILED",
                "A task cannot change its list by editing; its list is fixed by its place in the tree",
            );
        }

        const mergedStart = toDateOnly(input.start_date === undefined ? task.start_date : input.start_date);
        const mergedEnd = toDateOnly(input.end_date === undefined ? task.end_date : input.end_date);
        assertDateOrder(mergedStart, mergedEnd);

        // One batch id for the whole save: the scalar changes and the custom answers of this same
        // request land in one logical group even though they are separate statements.
        const batchId = TaskActivityService.newBatchId();
        const activity: TaskActivityChange[] = [];

        const changes: Record<string, unknown> = {};
        applyChange(changes, "title", input.title, task.title);
        applyChange(changes, "description", input.description, task.description);
        applyChange(changes, "start_date", input.start_date, toDateOnly(task.start_date));
        applyChange(changes, "end_date", input.end_date, toDateOnly(task.end_date));

        // The `changes` map is already the diff, so each entry present in it is exactly one history
        // row; `stored` is the pre-change side the task row was loaded with.
        const scalarFields: ReadonlyArray<readonly [string, string, unknown]> = [
            ["title", TASK_ACTIVITY_FIELD_LABELS.title, task.title],
            ["description", TASK_ACTIVITY_FIELD_LABELS.description, task.description],
            ["start_date", TASK_ACTIVITY_FIELD_LABELS.start_date, toDateOnly(task.start_date)],
            ["end_date", TASK_ACTIVITY_FIELD_LABELS.end_date, toDateOnly(task.end_date)],
        ];
        for (const [field, fieldLabel, stored] of scalarFields) {
            if (changes[field] === undefined) continue;
            activity.push(
                buildActivityChange({
                    field_key: field,
                    field_label: fieldLabel,
                    old_value: stored,
                    new_value: changes[field],
                    // A value-like field displays as itself; only a catalog id needs its own label.
                    old_label: formatActivityValue(stored),
                    new_label: formatActivityValue(changes[field]),
                }),
            );
        }

        const statusChanged = input.status_id !== undefined && input.status_id !== task.status_id;
        const priorityChanged = input.priority_id !== undefined && input.priority_id !== task.priority_id;
        if (statusChanged || priorityChanged) {
            const catalogs = await TaskConfigService.listCatalog(actor);
            if (statusChanged) {
                const statusId = resolveCatalogId(catalogs.statuses, input.status_id, "status");
                if (statusId !== task.status_id) {
                    changes.status_id = statusId;
                    activity.push(
                        buildActivityChange({
                            field_key: "status_id",
                            field_label: TASK_ACTIVITY_FIELD_LABELS.status_id,
                            old_value: task.status_id,
                            new_value: statusId,
                            old_label: catalogLabelOf(catalogs.statuses, task.status_id),
                            new_label: catalogLabelOf(catalogs.statuses, statusId),
                        }),
                    );
                }
            }
            if (priorityChanged) {
                const priorityId = resolveCatalogId(catalogs.priorities, input.priority_id, "priority");
                if (priorityId !== task.priority_id) {
                    changes.priority_id = priorityId;
                    activity.push(
                        buildActivityChange({
                            field_key: "priority_id",
                            field_label: TASK_ACTIVITY_FIELD_LABELS.priority_id,
                            old_value: task.priority_id,
                            new_value: priorityId,
                            old_label: catalogLabelOf(catalogs.priorities, task.priority_id),
                            new_label: catalogLabelOf(catalogs.priorities, priorityId),
                        }),
                    );
                }
            }
        }

        const resolvedValues =
            input.custom_values === undefined
                ? []
                : await TaskFieldService.resolveValues(actor, input.custom_values);

        if (Object.keys(changes).length > 0) {
            await updateItem<unknown>("pm_task", task.id, {
                ...changes,
                updated_at: phNow(),
                updated_by: actor.userId,
            });
        }

        // After the write, never before: a failed update must leave no history row behind, and this
        // call cannot throw even when the trail table is missing.
        await TaskActivityService.record(actor, task.id, "updated", activity, batchId);

        if (resolvedValues.length > 0) {
            await TaskFieldService.writeValues(actor, task.id, resolvedValues, {
                action: "updated",
                batchId,
            });
        }

        const updated =
            Object.keys(changes).length > 0 ? await loadTaskScoped(actor, task.id, task.list_id) : task;
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

        // ONE row, for the subject only: the descendants were loaded as ids alone, so logging their
        // field values would be an invention. Only the subject's own row was in hand.
        await TaskActivityService.record(actor, task.id, "updated", [
            buildActivityChange({
                field_key: "title",
                field_label: TASK_ACTIVITY_FIELD_LABELS.title,
                old_value: task.title,
                new_value: null,
                old_label: task.title,
                new_label: null,
            }),
        ]);

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

import { DirectusRequestError, createItem, readItem, readItems } from "@/modules/project-management/services/directus-client";
import {
    DepartmentScopeError,
    assertSameDepartment,
    type ScopedAttachmentRow,
    type ScopedConfigRow,
} from "@/modules/project-management/services/scoping";
import type { ScopedActor } from "@/modules/project-management/services/actor-service";
import type { PermissionContext } from "@/modules/project-management/services/permission-service";
import { TaskConfigService, effectiveDefaultRow } from "@/modules/project-management/task-management/configure/services/task-config-service";
import { phNow } from "@/modules/project-management/utils/ph-time";
import {
    buildShaping,
    groupByTaskId,
    isDeletedFlag,
    liveFieldValues,
    liveNestedRows,
    toClientRow,
    toNumberOrNull,
    type DepartmentTaskList,
    type RawTaskRow,
    type TaskAssigneeRow,
    type TaskClientRow,
} from "./task-payload";
import { TaskFieldService } from "./task-field-service";
import type { CreateTaskInput } from "../types/pm-task.schema";

/**
 * The tasks service — the department's task collection, listed and created.
 *
 * The list is deliberately **one flat read of the whole department**: the tree is an adjacency list
 * (`parent_id`), Directus cannot express a recursive CTE, and the department's working set is small
 * by design — pagination is a client concern over roots only. Every read carries
 * `department_id = actor.departmentId` and `is_deleted = 0` in the Directus filter; nothing is
 * fetched first and filtered afterwards.
 *
 * Two read shapes, one contract:
 * - the primary shape asks `pm_task` for its nested O2M alias fields in the same request;
 * - the fallback (used when those aliases are not registered — the live registration currently
 *   declares `one_field: null` on both relations, so the aliased read 403s) issues one scoped query
 *   per child collection, each carrying its own explicit `is_deleted` filter.
 * Both normalise through `./task-payload`, so the wire shape cannot vary with registration state.
 */

/**
 * The O2M alias field names Directus generates on `pm_task` when the child-side relations are
 * registered. The aliased read is attempted first and the fallback below carries the request when
 * the names do not resolve; if the owner records different generated names, only these two
 * constants change.
 */
const ASSIGNEE_ALIAS = "pm_task_assignee";
const ATTACHMENT_ALIAS = "pm_task_attachment";

/** The coded failure kinds this service throws. The route maps them to 400 / 404 / 500. */
export type TaskServiceErrorCode = "VALIDATION_FAILED" | "NOT_FOUND" | "INTERNAL_FAIL";

/** A task-rule refusal, carrying the `CODE: message` shape conventions section 13 pins. */
export class TaskServiceError extends Error {
    readonly code: TaskServiceErrorCode;

    constructor(code: TaskServiceErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "TaskServiceError";
        this.code = code;
    }
}

/** One department's flat task set plus its nested rows, keyed by `task_id`. */
interface DepartmentTaskRows {
    readonly tasks: readonly RawTaskRow[];
    readonly assignees: ReadonlyMap<number, TaskAssigneeRow[]>;
    readonly attachments: ReadonlyMap<number, ScopedAttachmentRow[]>;
}

/**
 * Resolves the catalog id a task will store: a supplied id must be a LIVE row of the actor's
 * department, and an omitted or null one falls back to the kind's effective default. A kind with no
 * live row at all is the documented clear 400, never a foreign-key 500.
 *
 * Exported because the item PATCH path validates a supplied catalog reference with this same rule,
 * so a create and an update can never disagree about which row is referenceable.
 */
export function resolveCatalogId(
    rows: readonly ScopedConfigRow[],
    requested: number | null | undefined,
    kind: "status" | "priority",
): number {
    if (requested !== null && requested !== undefined) {
        const match = rows.find((row) => row.id === requested);
        if (match === undefined) {
            throw new TaskServiceError("VALIDATION_FAILED", `The selected ${kind} is not available in your department`);
        }
        return match.id;
    }

    const fallback = effectiveDefaultRow(rows);
    if (fallback === null) {
        throw new TaskServiceError(
            "VALIDATION_FAILED",
            `Your department has no ${kind} configured yet; add one in Settings before creating a task`,
        );
    }
    return fallback.id;
}

/**
 * `YYYY-MM-DD` strings compare chronologically as text, so no date parsing is needed. Exported
 * because the item PATCH path re-validates the **merged** start/end pair with this same rule.
 */
export function assertDateOrder(startDate: string | null | undefined, endDate: string | null | undefined): void {
    if (startDate === null || startDate === undefined || endDate === null || endDate === undefined) return;
    if (endDate < startDate) {
        throw new TaskServiceError("VALIDATION_FAILED", "The end date cannot be earlier than the start date");
    }
}

export class TaskService {
    /**
     * The department's whole live task set, flat, for the client to assemble into a tree.
     *
     * `permissions` is the caller's already-resolved context, so every row's `can_delete` uses the
     * exact predicate the delete route enforces — the UI can never disagree with the server.
     */
    static async listDepartmentTasks(actor: ScopedActor, permissions: PermissionContext): Promise<DepartmentTaskList> {
        const [source, catalogs, fields, values] = await Promise.all([
            TaskService.readDepartmentTasks(actor),
            TaskConfigService.listCatalog(actor),
            TaskFieldService.listEnabledFields(actor),
            TaskFieldService.listValues(actor),
        ]);
        const shaping = buildShaping(catalogs, permissions);
        const valuesByTask = groupByTaskId(liveFieldValues(values, fields));

        return {
            rows: source.tasks.map((row) =>
                toClientRow(
                    {
                        row,
                        assignees: source.assignees.get(row.id) ?? [],
                        attachments: source.attachments.get(row.id) ?? [],
                        values: valuesByTask.get(row.id) ?? [],
                    },
                    shaping,
                ),
            ),
            catalogs,
            fields,
        };
    }

    /**
     * Creates a task or a subtask in the actor's department.
     *
     * `department_id` and every audit column are injected here from the actor and `phNow()` — the
     * Zod schema strips unknown keys, so a body carrying them can never reach these columns. A
     * supplied `parent_id` is loaded unfiltered and then put through the department guard, so a
     * cross-department parent is refused rather than silently written; the new row is appended to
     * its sibling list (`max(sort_order) + 1`), because the DDL default of 0 would otherwise drop a
     * new root mid-list after any reorder.
     */
    static async createTask(
        actor: ScopedActor,
        permissions: PermissionContext,
        input: CreateTaskInput,
    ): Promise<TaskClientRow> {
        assertDateOrder(input.start_date, input.end_date);
        const parentId = await TaskService.resolveParentId(actor, input.parent_id);

        const [catalogs, resolvedValues] = await Promise.all([
            TaskConfigService.listCatalog(actor),
            TaskFieldService.resolveValues(actor, input.custom_values ?? []),
        ]);
        const statusId = resolveCatalogId(catalogs.statuses, input.status_id, "status");
        const priorityId = resolveCatalogId(catalogs.priorities, input.priority_id, "priority");
        const sortOrder = (await TaskService.maxSiblingSortOrder(actor, parentId)) + 1;

        const now = phNow();
        const created = await createItem<unknown>("pm_task", {
            department_id: actor.departmentId,
            parent_id: parentId,
            status_id: statusId,
            priority_id: priorityId,
            title: input.title,
            description: input.description ?? null,
            start_date: input.start_date ?? null,
            end_date: input.end_date ?? null,
            sort_order: sortOrder,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });

        const createdId = toNumberOrNull((created as { readonly id?: unknown } | null)?.id);
        const fallback = createdId === null ? await TaskService.readNewestOwnTask(actor) : null;
        const taskId = createdId ?? fallback?.id ?? null;
        if (taskId === null) {
            throw new TaskServiceError("INTERNAL_FAIL", "The task was created but could not be read back");
        }

        if (resolvedValues.length > 0) {
            await TaskFieldService.writeValues(actor, taskId, resolvedValues);
        }

        // Columns the body did not answer inherit their default — see `applyDefaults`, which is
        // create-only so an edit can never re-apply a default over a deliberately cleared answer.
        await TaskFieldService.applyDefaults(
            actor,
            taskId,
            resolvedValues.map((entry) => entry.field_id),
        );

        const row = await readItem<RawTaskRow>("pm_task", taskId);
        if (row === null) {
            throw new TaskServiceError("INTERNAL_FAIL", "The task was created but could not be read back");
        }

        return toClientRow(
            {
                row,
                assignees: [],
                attachments: [],
                values: await TaskFieldService.listValuesFor(actor, taskId),
            },
            buildShaping(catalogs, permissions),
        );
    }

    /**
     * The flat department read. The aliased form is attempted first; when the O2M alias fields are
     * not registered the fallback issues one scoped query per child collection instead — every one
     * of them carrying `department_id` and `is_deleted`.
     *
     * Alias availability is detected two ways because this Directus does both: an unregistered
     * **nested** field is silently dropped from a 200 response (the alias key is simply absent),
     * while an unregistered **flat** field is refused with a 403. Either signal falls back, so an
     * empty `assignees`/`attachments` array is never fabricated from a missing alias.
     */
    private static async readDepartmentTasks(actor: ScopedActor): Promise<DepartmentTaskRows> {
        const filter = {
            department_id: { _eq: actor.departmentId },
            is_deleted: { _eq: 0 },
        };

        try {
            const tasks = await readItems<RawTaskRow>("pm_task", {
                filter,
                fields: ["*", `${ASSIGNEE_ALIAS}.*`, `${ATTACHMENT_ALIAS}.*`],
                sort: ["sort_order", "id"],
                limit: -1,
            });
            if (TaskService.exposesNestedAliases(tasks)) {
                return {
                    tasks,
                    assignees: groupByTaskId(
                        liveNestedRows<TaskAssigneeRow>(tasks.flatMap((task) => task[ASSIGNEE_ALIAS])),
                    ),
                    attachments: groupByTaskId(
                        liveNestedRows<ScopedAttachmentRow>(tasks.flatMap((task) => task[ATTACHMENT_ALIAS])),
                    ),
                };
            }
            console.warn(
                "[tasks] pm_task does not expose the nested assignee/attachment aliases; falling back to scoped per-collection queries",
            );
        } catch (error) {
            if (!(error instanceof DirectusRequestError)) throw error;
            console.warn(
                `[tasks] the nested alias read for pm_task failed with status ${error.status}; falling back to scoped per-collection queries`,
            );
        }

        const [tasks, assignees, attachments] = await Promise.all([
            readItems<RawTaskRow>("pm_task", { filter, sort: ["sort_order", "id"], limit: -1 }),
            readItems<TaskAssigneeRow>("pm_task_assignee", { filter, limit: -1 }),
            readItems<ScopedAttachmentRow>("pm_task_attachment", { filter, limit: -1 }),
        ]);

        return {
            tasks,
            assignees: groupByTaskId(liveNestedRows<TaskAssigneeRow>(assignees)),
            attachments: groupByTaskId(liveNestedRows<ScopedAttachmentRow>(attachments)),
        };
    }

    /**
     * A registered O2M alias surfaces as a key on the rows; an unregistered one is silently dropped.
     * An empty task set cannot answer the question and needs no fallback — no row could carry
     * nested data for a task the payload does not return.
     */
    private static exposesNestedAliases(tasks: readonly RawTaskRow[]): boolean {
        return tasks.length === 0 || tasks.some((task) => ASSIGNEE_ALIAS in task || ATTACHMENT_ALIAS in task);
    }

    /**
     * Validates a supplied parent: it must be a live task **in the actor's department**. The row is
     * read unfiltered — through a list query, never `readItem`, because this Directus answers 403
     * (not 404) when a single-item read misses — so the department guard sees the real owner, then
     * `assertSameDepartment` refuses a mismatch. Both misses collapse to the same 400 message, so
     * the refusal never confirms whether another department's row exists.
     *
     * Shared with the move route's target-parent validation: create and move must never disagree
     * about which parent is referenceable. The move route additionally rejects a target that is the
     * moved node itself or one of its descendants — checks that need the tree, so they stay there.
     */
    static async resolveParentId(
        actor: ScopedActor,
        parentId: number | null | undefined,
    ): Promise<number | null> {
        if (parentId === null || parentId === undefined) return null;

        const parents = await readItems<{ readonly department_id?: unknown; readonly is_deleted?: unknown }>(
            "pm_task",
            { filter: { id: { _eq: parentId } }, fields: ["department_id", "is_deleted"], limit: 1 },
        );
        const parent = parents[0];
        const refusal = "The parent task must be an existing task in your department";
        if (parent === undefined || isDeletedFlag(parent.is_deleted)) {
            throw new TaskServiceError("VALIDATION_FAILED", refusal);
        }
        try {
            assertSameDepartment(actor, parent);
        } catch (error) {
            if (error instanceof DepartmentScopeError) throw new TaskServiceError("VALIDATION_FAILED", refusal);
            throw error;
        }
        return parentId;
    }

    /** The highest `sort_order` among the destination parent's live children, `-1` when none. */
    private static async maxSiblingSortOrder(actor: ScopedActor, parentId: number | null): Promise<number> {
        const siblings = await readItems<{ readonly sort_order?: unknown }>("pm_task", {
            filter: {
                department_id: { _eq: actor.departmentId },
                is_deleted: { _eq: 0 },
                parent_id: parentId === null ? { _null: true } : { _eq: parentId },
            },
            fields: ["sort_order"],
            limit: -1,
        });

        let highest = -1;
        for (const sibling of siblings) {
            const sortOrder = toNumberOrNull(sibling.sort_order);
            if (sortOrder !== null && sortOrder > highest) highest = sortOrder;
        }
        return highest;
    }

    /**
     * The actor's newest live task in their department — the create read-back of last resort when
     * Directus answers the mutation with 204 No Content instead of the created item.
     */
    private static async readNewestOwnTask(actor: ScopedActor): Promise<RawTaskRow | null> {
        const rows = await readItems<RawTaskRow>("pm_task", {
            filter: {
                department_id: { _eq: actor.departmentId },
                created_by: { _eq: actor.userId },
                is_deleted: { _eq: 0 },
            },
            sort: ["-id"],
            limit: 1,
        });
        return rows[0] ?? null;
    }
}

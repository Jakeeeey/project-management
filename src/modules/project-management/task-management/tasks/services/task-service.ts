import { DirectusRequestError, createItem, readItem, readItems } from "./directus-client";
import {
    DepartmentScopeError,
    assertSameDepartment,
    type ScopedAttachmentRow,
    type ScopedConfigRow,
} from "./scoping";
import type { ScopedActor } from "./actor-service";
import type { PermissionContext } from "./permission-service";
import { TaskConfigService, effectiveDefaultRow } from "@/modules/project-management/task-management/configure/services/task-config-service";
import { TaskListService } from "./task-list-service";
import { resolveTaskListId, type ListResolution } from "./task-list-policy";
import { phNow } from "../utils/ph-time";
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
import { TASK_ACTIVITY_FIELD_LABELS, buildActivityChange, catalogLabelOf, type TaskActivityChange } from "./task-activity-delta";
import { TaskActivityService } from "./task-activity-service";
import type { CreateTaskInput } from "../types/pm-task.schema";

/**
 * The tasks service — the department's task collection, listed and created.
 *
 * The list is deliberately **one flat read of the whole department**: the tree is an adjacency list
 * (`parent_id`), Directus cannot express a recursive CTE, and the department's working set is small
 * by design — pagination is a client concern over roots only. Every TASK read carries
 * `department_id = actor.departmentId`, the resolved `list_id` and `is_deleted = 0` in the Directus
 * filter; nothing is fetched first and filtered afterwards. The child collections carry no list
 * dimension of their own — an assignment or an attachment is reached through its task — so their
 * reads are narrowed by `department_id` + `is_deleted` and then attached to the returned tasks by
 * `task_id`; pushing `list_id` into them is refused by Directus (the column does not exist there).
 *
 * Two read shapes, one contract:
 * - the primary shape asks `pm_task` for its nested O2M alias fields in the same request;
 * - the fallback (used when those aliases are not registered — the live registration currently
 *   declares `one_field: null` on both relations, so the aliased read 403s) issues one scoped query
 *   per child collection, each carrying its own explicit `department_id` and `is_deleted` filter.
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
 * A validated parent task: its id, plus the list a subtask must share. Returned by
 * `TaskService.resolveParent`, which the create path (to inherit the list) and the move path (to
 * refuse a cross-list target) both use.
 */
export interface ResolvedParent {
    readonly id: number;
    readonly listId: number | null;
}

/**
 * Maps a refused list resolution to the coded 400 the create route answers. An unknown id and
 * another department's id collapse to the same `unknown-list` answer, so the refusal never
 * confirms whether a foreign list exists.
 */
function toListResolutionError(resolution: Exclude<ListResolution, { kind: "resolved" }>): TaskServiceError {
    switch (resolution.kind) {
        case "unknown-list":
            return new TaskServiceError("VALIDATION_FAILED", "The selected task list is not available in your department");
        case "subtask-list-mismatch":
            return new TaskServiceError(
                "VALIDATION_FAILED",
                "A subtask must belong to the same task list as its parent task",
            );
        case "no-list":
            return new TaskServiceError(
                "VALIDATION_FAILED",
                "Your department has no task list yet; ask your department head to create one before adding tasks",
            );
    }
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
     * One list's tasks — the department's whole live set for the requested list, flat, for the
     * client to assemble into a tree — plus both catalogs and the custom columns.
     *
     * `listId` is REQUIRED here even though it is optional on `loadTaskScoped`: this is a read OF A
     * LIST, so it must scope by list, while a by-id load happens before any list is known and list
     * is a view dimension rather than a boundary. `null` means the department has no live list to
     * read, which is answered with an empty task set rather than a query for an unscoped one.
     *
     * `permissions` is the caller's already-resolved context, so every row's `can_delete` uses the
     * exact predicate the delete route enforces — the UI can never disagree with the server.
     */
    static async listDepartmentTasks(
        actor: ScopedActor,
        permissions: PermissionContext,
        listId: number | null,
    ): Promise<DepartmentTaskList> {
        const [source, catalogs, fields, values] = await Promise.all([
            TaskService.readDepartmentTasks(actor, listId),
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
     *
     * The list resolves through `resolveTaskListId`: a root task takes the requested live list or
     * the department's default, while a subtask may only name — or, by omission, inherit — its
     * parent's list, so the exclusivity invariant holds from the first write.
     */
    static async createTask(
        actor: ScopedActor,
        permissions: PermissionContext,
        input: CreateTaskInput,
    ): Promise<TaskClientRow> {
        assertDateOrder(input.start_date, input.end_date);
        const parent = await TaskService.resolveParent(actor, input.parent_id);

        const [catalogs, resolvedValues, lists] = await Promise.all([
            TaskConfigService.listCatalog(actor),
            TaskFieldService.resolveValues(actor, input.custom_values ?? []),
            TaskListService.listLists(actor),
        ]);
        const listResolution = resolveTaskListId({
            lists,
            requestedListId: input.list_id ?? null,
            parentListId: parent?.listId ?? null,
        });
        if (listResolution.kind !== "resolved") throw toListResolutionError(listResolution);

        const statusId = resolveCatalogId(catalogs.statuses, input.status_id, "status");
        const priorityId = resolveCatalogId(catalogs.priorities, input.priority_id, "priority");
        const sortOrder = (await TaskService.maxSiblingSortOrder(actor, parent?.id ?? null)) + 1;

        const now = phNow();
        const created = await createItem<unknown>("pm_task", {
            department_id: actor.departmentId,
            parent_id: parent?.id ?? null,
            list_id: listResolution.listId,
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

        // One batch id for the whole create: the task-level rows, the body's custom answers and the
        // defaults that land afterwards all read back as one "created" action.
        const batchId = TaskActivityService.newBatchId();
        const activity: TaskActivityChange[] = [
            buildActivityChange({
                field_key: "title",
                field_label: TASK_ACTIVITY_FIELD_LABELS.title,
                old_value: null,
                new_value: input.title,
                new_label: input.title,
            }),
        ];

        // Every other field that ended up non-null — including the ones the body never supplied, whose
        // resolved defaults are just as much a part of what the task starts life with. A root task's
        // `parent_id` and the appended `sort_order` carry no display text of their own.
        const optionalFields: ReadonlyArray<readonly [string, string, string | null, string | null]> = [
            ["description", TASK_ACTIVITY_FIELD_LABELS.description, input.description ?? null, input.description ?? null],
            ["start_date", TASK_ACTIVITY_FIELD_LABELS.start_date, input.start_date ?? null, input.start_date ?? null],
            ["end_date", TASK_ACTIVITY_FIELD_LABELS.end_date, input.end_date ?? null, input.end_date ?? null],
            ["parent_id", TASK_ACTIVITY_FIELD_LABELS.parent_id, parent === null ? null : String(parent.id), null],
        ];
        for (const [field, fieldLabel, value, display] of optionalFields) {
            if (value === null) continue;
            activity.push(
                buildActivityChange({
                    field_key: field,
                    field_label: fieldLabel,
                    old_value: null,
                    new_value: value,
                    new_label: display,
                }),
            );
        }

        activity.push(
            buildActivityChange({
                field_key: "status_id",
                field_label: TASK_ACTIVITY_FIELD_LABELS.status_id,
                old_value: null,
                new_value: statusId,
                new_label: catalogLabelOf(catalogs.statuses, statusId),
            }),
            buildActivityChange({
                field_key: "priority_id",
                field_label: TASK_ACTIVITY_FIELD_LABELS.priority_id,
                old_value: null,
                new_value: priorityId,
                new_label: catalogLabelOf(catalogs.priorities, priorityId),
            }),
            buildActivityChange({
                field_key: "sort_order",
                field_label: TASK_ACTIVITY_FIELD_LABELS.sort_order,
                old_value: null,
                new_value: sortOrder,
            }),
        );

        await TaskActivityService.record(actor, taskId, "created", activity, batchId);

        if (resolvedValues.length > 0) {
            await TaskFieldService.writeValues(actor, taskId, resolvedValues, { action: "created", batchId });
        }

        // Columns the body did not answer inherit their default — see `applyDefaults`, which is
        // create-only so an edit can never re-apply a default over a deliberately cleared answer. The
        // same activity context is threaded through, so a default is attributed to the create itself.
        await TaskFieldService.applyDefaults(
            actor,
            taskId,
            resolvedValues.map((entry) => entry.field_id),
            { action: "created", batchId },
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
     * The flat read of ONE list. The aliased form is attempted first; when the O2M alias fields are
     * not registered the fallback issues one scoped query per child collection instead — the tasks
     * query carrying `department_id`, `list_id` and `is_deleted`, and the child queries carrying
     * `department_id` and `is_deleted` only.
     *
     * Alias availability is detected two ways because this Directus does both: an unregistered
     * **nested** field is silently dropped from a 200 response (the alias key is simply absent),
     * while an unregistered **flat** field is refused with a 403. Either signal falls back, so an
     * empty `assignees`/`attachments` array is never fabricated from a missing alias.
     *
     * A `null` list means the department has no live list at all: there is nothing to scope a read
     * to, so an empty set is answered directly rather than querying for an unscoped one.
     */
    private static async readDepartmentTasks(actor: ScopedActor, listId: number | null): Promise<DepartmentTaskRows> {
        if (listId === null) {
            return {
                tasks: [],
                assignees: new Map<number, TaskAssigneeRow[]>(),
                attachments: new Map<number, ScopedAttachmentRow[]>(),
            };
        }

        const filter = {
            department_id: { _eq: actor.departmentId },
            list_id: { _eq: listId },
            is_deleted: { _eq: 0 },
        };

        /**
         * The child collections have no `list_id` — a list scopes TASKS, not their nested rows — so
         * the tasks filter above cannot be reused for them: Directus refuses the whole read with a
         * 403 ("no such field"), which surfaced as the page's generic 500. `department_id` +
         * `is_deleted` keeps the read scoped, and `groupByTaskId` attaches a child only to the task
         * it names, so rows belonging to another list simply never join.
         */
        const childFilter = {
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
            readItems<TaskAssigneeRow>("pm_task_assignee", { filter: childFilter, limit: -1 }),
            readItems<ScopedAttachmentRow>("pm_task_attachment", { filter: childFilter, limit: -1 }),
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
     * Returns the parent's id together with its list: the create path inherits that list for a
     * subtask, and the move path refuses a target whose list differs from the moved task's — one
     * lookup, so create and move can never disagree about which parent is referenceable or which
     * list a child may join.
     */
    static async resolveParent(
        actor: ScopedActor,
        parentId: number | null | undefined,
    ): Promise<ResolvedParent | null> {
        if (parentId === null || parentId === undefined) return null;

        const parents = await readItems<{
            readonly department_id?: unknown;
            readonly is_deleted?: unknown;
            readonly list_id?: unknown;
        }>("pm_task", {
            filter: { id: { _eq: parentId } },
            fields: ["department_id", "is_deleted", "list_id"],
            limit: 1,
        });
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
        return { id: parentId, listId: toNumberOrNull(parent.list_id) };
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

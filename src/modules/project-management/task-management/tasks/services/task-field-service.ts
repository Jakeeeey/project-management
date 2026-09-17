import {
    DirectusRequestError,
    createItem,
    readItems,
    updateItem,
    updateItems,
} from "@/modules/project-management/services/directus-client";
import {
    loadFieldOptionScoped,
    loadFieldScoped,
    type ScopedFieldOptionRow,
    type ScopedFieldRow,
    type ScopedFieldValueRow,
} from "@/modules/project-management/services/scoping";
import type { ScopedActor } from "@/modules/project-management/services/actor-service";
import { isTrueFlag } from "@/modules/project-management/task-management/configure/services/task-config-policy";
import { phNow } from "@/modules/project-management/utils/ph-time";
import {
    TaskFieldTypeSchema,
    type CreateTaskFieldInput,
    type CreateTaskFieldOptionInput,
    type TaskFieldValueInput,
    type UpdateTaskFieldInput,
    type UpdateTaskFieldOptionInput,
} from "../types/task-field.schema";
import { TaskFieldValueError, normaliseFieldValue } from "./task-field-value";

/**
 * The custom-column service — the department's own columns on the task list, their choices, and the
 * answers each task stores.
 *
 * Three tables, one feature: `pm_task_field` is a column, `pm_task_field_option` is a choice of a
 * `select` column, and `pm_task_field_value` is one task's answer. A column is referenced by primary
 * key, so renaming one is a single-row write that every task reflects immediately.
 *
 * Scoping: every read and every write carries `department_id` from the actor, and every named row is
 * loaded through the scoped loaders in `services/scoping.ts` first, so a write can never reach
 * another department's column. The route owns the `assertCanConfigure` capability check for the
 * builder and `assertCanEdit` for the answers; this service owns the data rules (duplicate labels,
 * the select-only rule for choices, the per-type value rules, the revive-or-insert value write) and
 * audit injection.
 */

/** The coded failure kinds this service throws. The route maps them to 400 / 404 / 500. */
export type TaskFieldErrorCode = "VALIDATION_FAILED" | "NOT_FOUND" | "INTERNAL_FAIL";

/** A custom-column refusal, carrying the `CODE: message` shape conventions section 13 pins. */
export class TaskFieldError extends Error {
    readonly code: TaskFieldErrorCode;

    constructor(code: TaskFieldErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "TaskFieldError";
        this.code = code;
    }
}

/** A custom column plus its live choices — the shape both the builder and the task list read. */
export interface TaskFieldClientRow extends ScopedFieldRow {
    readonly options: readonly ScopedFieldOptionRow[];
}

/** One task's answer, as the task payload carries it. */
export interface TaskFieldValueClientRow {
    readonly field_id: number;
    readonly value: string | null;
}

/** A validated answer, ready to be written. */
export interface ResolvedFieldValue {
    readonly field_id: number;
    readonly value: string | null;
}

/** `(sort_order, id)` — every custom-column list has this one order. */
function sortByOrderThenId<T extends { readonly sort_order: unknown; readonly id: number }>(
    rows: readonly T[],
): T[] {
    return [...rows].sort((left, right) => Number(left.sort_order) - Number(right.sort_order) || left.id - right.id);
}

export class TaskFieldService {
    /** Every live column of the department with its live choices, ordered by `(sort_order, id)`. */
    static async listFields(actor: ScopedActor): Promise<TaskFieldClientRow[]> {
        const [fields, options] = await Promise.all([
            TaskFieldService.readLiveFields(actor),
            TaskFieldService.readLiveOptions(actor),
        ]);

        return fields.map((field) => ({
            ...field,
            options: options.filter((option) => option.field_id === field.id),
        }));
    }

    /** Every live answer of the department, for the task list to attach to its rows. */
    static async listValues(actor: ScopedActor): Promise<ScopedFieldValueRow[]> {
        return TaskFieldService.readRowsOrEmpty(() =>
            readItems<ScopedFieldValueRow>("pm_task_field_value", {
                filter: {
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: -1,
            }),
        );
    }

    /** One task's live answers — the item route's read-back after a write. */
    static async listValuesFor(actor: ScopedActor, taskId: number): Promise<ScopedFieldValueRow[]> {
        return TaskFieldService.readRowsOrEmpty(() =>
            readItems<ScopedFieldValueRow>("pm_task_field_value", {
                filter: {
                    task_id: { _eq: taskId },
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: -1,
            }),
        );
    }

    /**
     * Adds a custom column to the actor's department.
     *
     * Rejected with a 400 when a live column already carries the label — the table has no unique key,
     * so the check is read-then-write. The created row is read back by its label because Directus may
     * answer a mutation with 204 No Content.
     */
    static async createField(actor: ScopedActor, input: CreateTaskFieldInput): Promise<TaskFieldClientRow> {
        const live = await TaskFieldService.readLiveFields(actor);
        const duplicate = live.find((field) => field.label === input.label);
        if (duplicate !== undefined) {
            throw new TaskFieldError(
                "VALIDATION_FAILED",
                `Another live column already uses the label "${duplicate.label}"`,
            );
        }

        const now = phNow();
        await createItem<unknown>("pm_task_field", {
            department_id: actor.departmentId,
            label: input.label,
            field_type: input.field_type,
            sort_order: input.sort_order ?? 0,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });

        return TaskFieldService.readCreatedField(actor, input.label);
    }

    /** Renames or reorders one live column. The type is never patchable — see the schema's note. */
    static async updateField(
        actor: ScopedActor,
        id: string | number,
        input: UpdateTaskFieldInput,
    ): Promise<TaskFieldClientRow> {
        const target = await TaskFieldService.requireLiveField(actor, id);

        if (input.label !== undefined) {
            const live = await TaskFieldService.readLiveFields(actor);
            const duplicate = live.find((field) => field.label === input.label && field.id !== target.id);
            if (duplicate !== undefined) {
                throw new TaskFieldError(
                    "VALIDATION_FAILED",
                    `Another live column already uses the label "${duplicate.label}"`,
                );
            }
        }

        const changes: { label?: string; sort_order?: number } = {};
        if (input.label !== undefined) changes.label = input.label;
        if (input.sort_order !== undefined) changes.sort_order = input.sort_order;

        const now = phNow();
        await updateItem<unknown>("pm_task_field", target.id, {
            ...changes,
            updated_at: now,
            updated_by: actor.userId,
        });

        return {
            ...target,
            ...changes,
            updated_at: now,
            updated_by: actor.userId,
            options: await TaskFieldService.readOptionsOf(actor, target.id),
        };
    }

    /**
     * Soft-deletes a column and every live choice it offers — never a hard delete.
     *
     * The stored answers are deliberately left alone: a column can be revived, and every task's
     * answer is still there. The task list stops rendering the column the moment the field is gone.
     */
    static async softDeleteField(actor: ScopedActor, id: string | number): Promise<TaskFieldClientRow> {
        const target = await TaskFieldService.requireLiveField(actor, id);
        const options = await TaskFieldService.readOptionsOf(actor, target.id);
        const now = phNow();

        await updateItem<unknown>("pm_task_field", target.id, {
            is_deleted: 1,
            updated_at: now,
            updated_by: actor.userId,
        });

        if (options.length > 0) {
            await updateItems<unknown>(
                "pm_task_field_option",
                options.map((option) => ({
                    id: option.id,
                    is_deleted: 1,
                    updated_at: now,
                    updated_by: actor.userId,
                })),
            );
        }

        return { ...target, is_deleted: 1, updated_at: now, updated_by: actor.userId, options: [] };
    }

    /** Adds a choice to a `select` column. A column of any other type has no choices to offer. */
    static async createOption(actor: ScopedActor, input: CreateTaskFieldOptionInput): Promise<ScopedFieldOptionRow> {
        const field = await TaskFieldService.requireSelectField(actor, input.field_id);
        const live = await TaskFieldService.readOptionsOf(actor, field.id);
        const duplicate = live.find((option) => option.label === input.label);
        if (duplicate !== undefined) {
            throw new TaskFieldError(
                "VALIDATION_FAILED",
                `The column "${field.label}" already offers the choice "${duplicate.label}"`,
            );
        }

        const now = phNow();
        await createItem<unknown>("pm_task_field_option", {
            field_id: field.id,
            department_id: actor.departmentId,
            label: input.label,
            sort_order: input.sort_order ?? 0,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });

        return TaskFieldService.readCreatedOption(actor, field.id, input.label);
    }

    /** Renames or reorders one live choice. A choice never moves to another column. */
    static async updateOption(
        actor: ScopedActor,
        id: string | number,
        input: UpdateTaskFieldOptionInput,
    ): Promise<ScopedFieldOptionRow> {
        const target = await TaskFieldService.requireLiveOption(actor, id);

        if (input.label !== undefined) {
            const live = await TaskFieldService.readOptionsOf(actor, target.field_id);
            const duplicate = live.find((option) => option.label === input.label && option.id !== target.id);
            if (duplicate !== undefined) {
                throw new TaskFieldError(
                    "VALIDATION_FAILED",
                    `This column already offers the choice "${duplicate.label}"`,
                );
            }
        }

        const changes: { label?: string; sort_order?: number } = {};
        if (input.label !== undefined) changes.label = input.label;
        if (input.sort_order !== undefined) changes.sort_order = input.sort_order;

        const now = phNow();
        await updateItem<unknown>("pm_task_field_option", target.id, {
            ...changes,
            updated_at: now,
            updated_by: actor.userId,
        });

        return { ...target, ...changes, updated_at: now, updated_by: actor.userId };
    }

    /**
     * Soft-deletes one choice. Tasks that already picked it keep the stored id and render the
     * "removed choice" placeholder, so removing a choice never rewrites a task row.
     */
    static async softDeleteOption(actor: ScopedActor, id: string | number): Promise<ScopedFieldOptionRow> {
        const target = await TaskFieldService.requireLiveOption(actor, id);
        const now = phNow();

        await updateItem<unknown>("pm_task_field_option", target.id, {
            is_deleted: 1,
            updated_at: now,
            updated_by: actor.userId,
        });

        return { ...target, is_deleted: 1, updated_at: now, updated_by: actor.userId };
    }

    /**
     * Validates a body's answers against the department's live columns and returns what to write.
     *
     * Every answer is put through the column's own type rule, and a `select` answer must additionally
     * name a **live choice of that same column** — otherwise a task could store an id no picker can
     * show. The same column named twice is refused rather than letting the last one silently win.
     */
    static async resolveValues(
        actor: ScopedActor,
        inputs: readonly TaskFieldValueInput[],
    ): Promise<ResolvedFieldValue[]> {
        if (inputs.length === 0) return [];

        const fields = await TaskFieldService.listFields(actor);
        const byId = new Map(fields.map((field) => [field.id, field]));
        const seen = new Set<number>();
        const resolved: ResolvedFieldValue[] = [];

        for (const input of inputs) {
            if (seen.has(input.field_id)) {
                throw new TaskFieldError("VALIDATION_FAILED", "The body sets the same custom column twice");
            }
            seen.add(input.field_id);

            const field = byId.get(input.field_id);
            if (field === undefined) {
                throw new TaskFieldError(
                    "VALIDATION_FAILED",
                    "A custom column in the body is not available in your department",
                );
            }

            const type = TaskFieldTypeSchema.safeParse(field.field_type);
            if (!type.success) {
                throw new TaskFieldError("INTERNAL_FAIL", `The column "${field.label}" has an unknown type`);
            }

            let value: string | null;
            try {
                value = normaliseFieldValue(type.data, input.value);
            } catch (error) {
                if (error instanceof TaskFieldValueError) {
                    throw new TaskFieldError("VALIDATION_FAILED", `"${field.label}": ${error.message}`);
                }
                throw error;
            }

            if (type.data === "select" && value !== null && !field.options.some((option) => String(option.id) === value)) {
                throw new TaskFieldError("VALIDATION_FAILED", `"${field.label}" does not offer that choice`);
            }

            resolved.push({ field_id: field.id, value });
        }

        return resolved;
    }

    /**
     * Writes validated answers for one task.
     *
     * The row is looked up **including soft-deleted ones** and revived, because
     * `uq_pm_task_field_value (task_id, field_id)` ignores `is_deleted` — a blind INSERT after a
     * cleared answer would be a `Duplicate entry` error. A row whose stored value is already what the
     * body asked for is left untouched, so a no-op PATCH writes nothing.
     */
    static async writeValues(
        actor: ScopedActor,
        taskId: number,
        resolved: readonly ResolvedFieldValue[],
    ): Promise<void> {
        if (resolved.length === 0) return;
        const now = phNow();

        for (const entry of resolved) {
            const existing = await readItems<ScopedFieldValueRow>("pm_task_field_value", {
                filter: {
                    task_id: { _eq: taskId },
                    field_id: { _eq: entry.field_id },
                },
                limit: 1,
            });

            const row = existing[0];

            // Clearing an answer hides the row rather than storing an empty string, so "no answer" has
            // exactly one representation: absent. The row itself is kept, because the unique key
            // ignores `is_deleted` — a later value revives it instead of inserting a duplicate.
            if (entry.value === null) {
                if (row !== undefined && !isTrueFlag(row.is_deleted)) {
                    await updateItem<unknown>("pm_task_field_value", row.id, {
                        is_deleted: 1,
                        updated_at: now,
                        updated_by: actor.userId,
                    });
                }
                continue;
            }

            if (row === undefined) {
                await createItem<unknown>("pm_task_field_value", {
                    task_id: taskId,
                    field_id: entry.field_id,
                    department_id: actor.departmentId,
                    value: entry.value,
                    is_deleted: 0,
                    created_at: now,
                    created_by: actor.userId,
                    updated_at: now,
                    updated_by: actor.userId,
                });
                continue;
            }

            if (!isTrueFlag(row.is_deleted) && row.value === entry.value) continue;

            await updateItem<unknown>("pm_task_field_value", row.id, {
                value: entry.value,
                is_deleted: 0,
                updated_at: now,
                updated_by: actor.userId,
            });
        }
    }

    /** The department's live columns, ordered. Every column read funnels through here. */
    private static async readLiveFields(actor: ScopedActor): Promise<ScopedFieldRow[]> {
        const rows = await TaskFieldService.readRowsOrEmpty(() =>
            readItems<ScopedFieldRow>("pm_task_field", {
                filter: {
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: -1,
            }),
        );
        return sortByOrderThenId(rows);
    }

    /** The department's live choices across every column, ordered. */
    private static async readLiveOptions(actor: ScopedActor): Promise<ScopedFieldOptionRow[]> {
        const rows = await TaskFieldService.readRowsOrEmpty(() =>
            readItems<ScopedFieldOptionRow>("pm_task_field_option", {
                filter: {
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: -1,
            }),
        );
        return sortByOrderThenId(rows);
    }

    /**
     * Runs a read that a pre-DDL deployment cannot satisfy.
     *
     * The custom-column tables ship in a change of their own, so a deployment whose owner has not run
     * the DDL yet must still serve the tasks list: an unregistered collection answers 403, which is a
     * *registration* state, not a defect. Only that state is swallowed — a genuine Directus failure
     * still throws, so an outage is never silently rendered as "this department has no custom columns".
     */
    private static async readRowsOrEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
        try {
            return await read();
        } catch (error: unknown) {
            if (error instanceof DirectusRequestError && (error.status === 403 || error.status === 404)) {
                console.error(
                    `[task-fields] the custom-column tables are unavailable (status ${error.status}); ` +
                        "falling back to no custom columns. Run the change-5 DDL and register the collections in Directus.",
                );
                return [];
            }
            throw error;
        }
    }

    /** One column's live choices, ordered. */
    private static async readOptionsOf(actor: ScopedActor, fieldId: number): Promise<ScopedFieldOptionRow[]> {
        const rows = await readItems<ScopedFieldOptionRow>("pm_task_field_option", {
            filter: {
                department_id: { _eq: actor.departmentId },
                field_id: { _eq: fieldId },
                is_deleted: { _eq: 0 },
            },
            limit: -1,
        });
        return sortByOrderThenId(rows);
    }

    /** Loads one live column of the actor's department, or throws the coded 404 the route maps. */
    private static async requireLiveField(actor: ScopedActor, id: string | number): Promise<ScopedFieldRow> {
        const row = await loadFieldScoped(actor, id);
        if (row === null) {
            throw new TaskFieldError("NOT_FOUND", "No live custom column with that id exists in the actor's department");
        }
        return row;
    }

    /** Loads one live choice of the actor's department, or throws the coded 404 the route maps. */
    private static async requireLiveOption(actor: ScopedActor, id: string | number): Promise<ScopedFieldOptionRow> {
        const row = await loadFieldOptionScoped(actor, id);
        if (row === null) {
            throw new TaskFieldError("NOT_FOUND", "No live choice with that id exists in the actor's department");
        }
        return row;
    }

    /** Loads one live column and refuses it unless it can offer choices. */
    private static async requireSelectField(actor: ScopedActor, fieldId: string | number): Promise<ScopedFieldRow> {
        const field = await TaskFieldService.requireLiveField(actor, fieldId);
        if (field.field_type !== "select") {
            throw new TaskFieldError(
                "VALIDATION_FAILED",
                `Only a "select" column can offer choices; "${field.label}" is a ${field.field_type} column`,
            );
        }
        return field;
    }

    /** Reads a just-created column back by its label, which is unique among the live ones. */
    private static async readCreatedField(actor: ScopedActor, label: string): Promise<TaskFieldClientRow> {
        const rows = await readItems<ScopedFieldRow>("pm_task_field", {
            filter: {
                department_id: { _eq: actor.departmentId },
                is_deleted: { _eq: 0 },
                label: { _eq: label },
            },
            sort: ["-id"],
            limit: 1,
        });

        const row = rows[0];
        if (row === undefined) {
            throw new TaskFieldError("INTERNAL_FAIL", "The custom column was created but could not be read back");
        }
        return { ...row, options: [] };
    }

    /** Reads a just-created choice back by its label, which is unique within its column. */
    private static async readCreatedOption(
        actor: ScopedActor,
        fieldId: number,
        label: string,
    ): Promise<ScopedFieldOptionRow> {
        const rows = await readItems<ScopedFieldOptionRow>("pm_task_field_option", {
            filter: {
                department_id: { _eq: actor.departmentId },
                field_id: { _eq: fieldId },
                is_deleted: { _eq: 0 },
                label: { _eq: label },
            },
            sort: ["-id"],
            limit: 1,
        });

        const row = rows[0];
        if (row === undefined) {
            throw new TaskFieldError("INTERNAL_FAIL", "The choice was created but could not be read back");
        }
        return row;
    }
}
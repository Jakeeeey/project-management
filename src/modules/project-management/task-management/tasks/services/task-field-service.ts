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
    type TaskFieldType,
    type TaskFieldValueInput,
    type UpdateTaskFieldInput,
    type UpdateTaskFieldOptionInput,
} from "../types/task-field.schema";
import {
    TASK_ACTIVITY_CUSTOM_FIELD_KEY,
    buildActivityChange,
    type TaskActivityAction,
    type TaskActivityChange,
} from "./task-activity-delta";
import { TaskActivityService } from "./task-activity-service";
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
export interface TaskFieldClientRow extends Omit<ScopedFieldRow, "is_enabled" | "default_value"> {
    /**
     * Normalised, so no consumer has to know about the pre-DDL shape: a missing `is_enabled` column
     * reads as enabled (today's behaviour), never as disabled.
     */
    readonly is_enabled: boolean;
    /** The column's default answer, or `null`. A missing column reads as "no default". */
    readonly default_value: string | null;
    readonly options: readonly TaskFieldOptionClientRow[];
}

/** A choice with its colour normalised, so a missing `color` column reads as "no colour". */
export interface TaskFieldOptionClientRow extends Omit<ScopedFieldOptionRow, "color"> {
    readonly color: string | null;
}

/** One task's answer, as the task payload carries it. */
export interface TaskFieldValueClientRow {
    readonly field_id: number;
    readonly value: string | null;
}

/**
 * A validated answer, ready to be written — plus the column metadata the activity trail snapshots.
 *
 * The label travels WITH the answer because the resolver already loaded the column (and, for a
 * `select`, its choices), so the writer never has to re-read them just to label a history row.
 */
export interface ResolvedFieldValue {
    readonly field_id: number;
    readonly value: string | null;
    /** The column's `label` at write time — the history row's `field_label` snapshot. */
    readonly field_label: string;
    /** Choice labels by option id; present only for a `select` column, absent for every other type. */
    readonly option_labels?: ReadonlyMap<number, string>;
}

/**
 * How one `writeValues` call attributes the rows it adds to the activity trail.
 *
 * `action` separates a create's first answers (`created`) from a later edit (`updated`), and
 * `batchId` groups them with the rest of the same logical save — a create threads one id through its
 * task-level rows, its supplied answers and the defaults that land afterwards.
 */
export interface TaskFieldWriteActivity {
    readonly action: TaskActivityAction;
    readonly batchId: string;
}

/** `(sort_order, id)` — every custom-column list has this one order. */
function sortByOrderThenId<T extends { readonly sort_order: unknown; readonly id: number }>(
    rows: readonly T[],
): T[] {
    return [...rows].sort((left, right) => Number(left.sort_order) - Number(right.sort_order) || left.id - right.id);
}

/**
 * A `TINYINT(1)` flag that reads as ENABLED when the column is absent.
 *
 * `is_enabled` ships in a change of its own, so a deployment can be running this code before the
 * `ALTER TABLE`. A missing column must therefore mean "enabled" — today's behaviour — and NOT
 * "disabled", which would hide every existing custom column the moment this code deployed.
 */
function readEnabled(value: unknown): boolean {
    return value === undefined || isTrueFlag(value);
}

/** A stored TEXT that reads as `null` when absent or blank; a missing pre-DDL column is `null`. */
function readTextOrNull(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** A hex colour from the wire — validated here so a stored bad value cannot reach an inline style. */
function toHexOrNull(value: unknown): string | null {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
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
            is_enabled: readEnabled(field.is_enabled),
            default_value: readTextOrNull(field.default_value),
            options: options
                .filter((option) => option.field_id === field.id)
                .map((option) => ({ ...option, color: toHexOrNull(option.color) })),
        }));
    }

    /**
     * The ENFORCED columns only — what the task list renders and the task form offers.
     *
     * The builder reads `listFields` instead, because it must still show a disabled column so it can
     * be switched back on. A disabled column keeps every stored answer; it simply stops being a
     * column anyone sees.
     */
    static async listEnabledFields(actor: ScopedActor): Promise<TaskFieldClientRow[]> {
        return (await TaskFieldService.listFields(actor)).filter((field) => field.is_enabled);
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
        const defaultValue = TaskFieldService.normaliseDefault(input.field_type, input.default_value, input.label, []);
        await createItem<unknown>("pm_task_field", {
            department_id: actor.departmentId,
            label: input.label,
            field_type: input.field_type,
            sort_order: input.sort_order ?? 0,
            is_enabled: input.is_enabled === false ? 0 : 1,
            default_value: defaultValue,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });

        return TaskFieldService.readCreatedField(actor, input.label);
    }

    /**
     * Validates a column's default answer against its own type, or `null` for "no default".
     *
     * It reuses `normaliseFieldValue` — the same codec a task answer goes through — so a default can
     * never be something the column would refuse on a task; the two paths cannot drift. A `select`
     * default must additionally name a LIVE choice of that same column, which is what stops a default
     * from dangling after the choice it named is removed. The caller passes the options it has read.
     */
    private static normaliseDefault(
        type: TaskFieldType,
        raw: string | null | undefined,
        fieldLabel: string,
        options: readonly { readonly id: number }[],
    ): string | null {
        if (raw === null || raw === undefined) return null;

        let value: string | null;
        try {
            value = normaliseFieldValue(type, raw);
        } catch (error) {
            if (error instanceof TaskFieldValueError) {
                throw new TaskFieldError("VALIDATION_FAILED", `"${fieldLabel}" default: ${error.message}`);
            }
            throw error;
        }
        if (value === null) return null;

        if (type === "select" && !options.some((option) => String(option.id) === value)) {
            throw new TaskFieldError(
                "VALIDATION_FAILED",
                `"${fieldLabel}" default must be one of its own choices`,
            );
        }
        return value;
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

        const changes: {
            label?: string;
            sort_order?: number;
            is_enabled?: number;
            default_value?: string | null;
        } = {};
        if (input.label !== undefined) changes.label = input.label;
        if (input.sort_order !== undefined) changes.sort_order = input.sort_order;
        if (input.is_enabled !== undefined) changes.is_enabled = input.is_enabled ? 1 : 0;

        if (input.default_value !== undefined) {
            const type = TaskFieldTypeSchema.safeParse(target.field_type);
            if (!type.success) {
                throw new TaskFieldError("INTERNAL_FAIL", `The column "${target.label}" has an unknown type`);
            }
            const current = await TaskFieldService.readOptionsOf(actor, target.id);
            changes.default_value = TaskFieldService.normaliseDefault(
                type.data,
                input.default_value,
                target.label,
                current,
            );
        }

        const now = phNow();
        await updateItem<unknown>("pm_task_field", target.id, {
            ...changes,
            updated_at: now,
            updated_by: actor.userId,
        });

        const options = await TaskFieldService.readOptionsOf(actor, target.id);
        return {
            ...target,
            label: changes.label ?? target.label,
            sort_order: changes.sort_order ?? target.sort_order,
            is_enabled: changes.is_enabled === undefined ? readEnabled(target.is_enabled) : changes.is_enabled === 1,
            default_value:
                changes.default_value === undefined ? readTextOrNull(target.default_value) : changes.default_value,
            updated_at: now,
            updated_by: actor.userId,
            options: options.map((option) => ({ ...option, color: toHexOrNull(option.color) })),
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

        return {
            ...target,
            is_enabled: readEnabled(target.is_enabled),
            default_value: readTextOrNull(target.default_value),
            is_deleted: 1,
            updated_at: now,
            updated_by: actor.userId,
            options: [],
        };
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
            color: input.color ?? null,
            sort_order: input.sort_order ?? 0,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });

        return TaskFieldService.readCreatedOption(actor, field.id, input.label);
    }

    /** Renames, recolours or reorders one live choice. A choice never moves to another column. */
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

        const changes: { label?: string; sort_order?: number; color?: string | null } = {};
        if (input.label !== undefined) changes.label = input.label;
        if (input.sort_order !== undefined) changes.sort_order = input.sort_order;
        if (input.color !== undefined) changes.color = input.color;

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

        return { ...target, color: toHexOrNull(target.color), is_deleted: 1, updated_at: now, updated_by: actor.userId };
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

            const optionLabels =
                type.data === "select"
                    ? new Map(field.options.map((option) => [option.id, option.label] as const))
                    : null;
            resolved.push({
                field_id: field.id,
                value,
                field_label: field.label,
                ...(optionLabels === null ? {} : { option_labels: optionLabels }),
            });
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
        activity?: TaskFieldWriteActivity,
    ): Promise<void> {
        if (resolved.length === 0) return;
        const now = phNow();
        const changes: TaskActivityChange[] = [];

        for (const entry of resolved) {
            const existing = await readItems<ScopedFieldValueRow>("pm_task_field_value", {
                filter: {
                    task_id: { _eq: taskId },
                    field_id: { _eq: entry.field_id },
                },
                limit: 1,
            });

            const row = existing[0];
            // A soft-deleted row IS "no answer", so the old side of the history is `null` for it: that
            // is what makes a revive of the same value still read as a change.
            const previousValue = row === undefined || isTrueFlag(row.is_deleted) ? null : row.value;

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
                    changes.push(TaskFieldService.valueChange(entry, previousValue, null));
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
                changes.push(TaskFieldService.valueChange(entry, null, entry.value));
                continue;
            }

            if (!isTrueFlag(row.is_deleted) && row.value === entry.value) continue;

            await updateItem<unknown>("pm_task_field_value", row.id, {
                value: entry.value,
                is_deleted: 0,
                updated_at: now,
                updated_by: actor.userId,
            });
            changes.push(TaskFieldService.valueChange(entry, previousValue, entry.value));
        }

        await TaskActivityService.record(actor, taskId, activity?.action ?? "updated", changes, activity?.batchId);
    }

    /**
     * Writes each enabled column's default onto a NEWLY created task, for the columns the create body
     * left unanswered.
     *
     * Three deliberate restrictions:
     * - **Only on create.** An update never re-applies defaults, so editing a task can never silently
     *   overwrite an answer someone deliberately cleared.
     * - **Only enabled columns**, so a column nobody sees does not quietly populate new tasks.
     * - **The caller's answer always wins** — a supplied column is skipped, even if it was sent as
     *   `null` to clear it. A column with no default (`null`) is skipped too, rather than written as a
     *   blank row, so this cannot manufacture empty answers.
     */
    static async applyDefaults(
        actor: ScopedActor,
        taskId: number,
        suppliedFieldIds: readonly number[],
        activity?: TaskFieldWriteActivity,
    ): Promise<void> {
        const fields = await TaskFieldService.listEnabledFields(actor);
        const supplied = new Set(suppliedFieldIds);

        const defaults: ResolvedFieldValue[] = fields
            .filter((field) => !supplied.has(field.id) && field.default_value !== null)
            .map((field) => {
                const optionLabels =
                    field.field_type === "select"
                        ? new Map(field.options.map((option) => [option.id, option.label] as const))
                        : null;
                return {
                    field_id: field.id,
                    value: field.default_value,
                    field_label: field.label,
                    ...(optionLabels === null ? {} : { option_labels: optionLabels }),
                };
            });

        // The same activity context is threaded through, so a default that lands on a NEW task is
        // attributed to the create rather than reading as a later edit.
        await TaskFieldService.writeValues(actor, taskId, defaults, activity);
    }

    /**
     * The display text of one custom answer: a `select` shows its choice's label, and every other
     * type's stored text IS its display text. A choice the department no longer offers — or names —
     * has no label, so the history row keeps the raw id with a `null` label rather than inventing one.
     */
    private static valueLabel(entry: ResolvedFieldValue, value: string | null): string | null {
        if (value === null) return null;
        if (entry.option_labels === undefined) return value;
        const optionId = Number(value);
        return Number.isFinite(optionId) ? entry.option_labels.get(optionId) ?? null : null;
    }

    /** One custom-column change with both sides' labels snapshotted at write time. */
    private static valueChange(
        entry: ResolvedFieldValue,
        oldValue: string | null,
        newValue: string | null,
    ): TaskActivityChange {
        return buildActivityChange({
            field_key: TASK_ACTIVITY_CUSTOM_FIELD_KEY,
            field_id: entry.field_id,
            field_label: entry.field_label,
            old_value: oldValue,
            new_value: newValue,
            old_label: TaskFieldService.valueLabel(entry, oldValue),
            new_label: TaskFieldService.valueLabel(entry, newValue),
        });
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
        return {
            ...row,
            is_enabled: readEnabled(row.is_enabled),
            default_value: readTextOrNull(row.default_value),
            options: [],
        };
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
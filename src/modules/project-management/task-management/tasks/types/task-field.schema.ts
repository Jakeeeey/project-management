import { z } from "zod";

/**
 * The custom-column contracts for the tasks module — the ONLY definition of the `pm_task_field` /
 * `pm_task_field_option` payload shapes in the repository.
 *
 * A custom column is DATA, not an enum: a department adds its own columns at runtime, so the only
 * thing declared here is the four types the app knows how to render and validate.
 *
 * Deliberate omissions:
 * - No `is_deleted`, `department_id`, `created_by`, `updated_by`, `created_at` or `updated_at`:
 *   soft-delete is an action, and every audit column is injected server-side from the actor, so a
 *   client cannot set them. Zod strips unknown keys instead of failing, so a body carrying them is
 *   ignored rather than rejected.
 * - No `field_type` on the update schema: changing a column's type would strand every answer already
 *   stored under it (a `text` answer is not a `select` option id), so the type is immutable after
 *   creation. Changing it means adding a new column and removing the old one.
 */

export const TaskFieldTypeSchema = z.enum(["text", "number", "date", "select"]);

export type TaskFieldType = z.infer<typeof TaskFieldTypeSchema>;

/** Both `label` columns are `VARCHAR(100) NOT NULL`. Exported so the dialogs validate against the same rule the server enforces. */
export const TaskFieldLabelSchema = z
    .string()
    .trim()
    .min(1, "Label is required")
    .max(100, "Label must be 100 characters or fewer");

/** Both tables store `sort_order INT NOT NULL DEFAULT 0`; every list orders by `(sort_order, id)`. */
const SortOrderSchema = z.number().int().min(0, "Sort order must be zero or greater");

/** Any `pm_task_field` / `pm_task_field_option` key in JS number range. */
const IdentifierSchema = z.number().int().positive();

/** POST body for a new custom column. `sort_order` defaults to 0 server-side when omitted. */
export const CreateTaskFieldSchema = z.object({
    label: TaskFieldLabelSchema,
    field_type: TaskFieldTypeSchema,
    sort_order: SortOrderSchema.optional(),
});

/** PATCH body for an existing column. Every field is optional: only what changed is written. */
export const UpdateTaskFieldSchema = CreateTaskFieldSchema.partial().omit({ field_type: true });

/** POST body for a new choice on a `select` column. */
export const CreateTaskFieldOptionSchema = z.object({
    field_id: IdentifierSchema,
    label: TaskFieldLabelSchema,
    sort_order: SortOrderSchema.optional(),
});

/** PATCH body for an existing choice. `field_id` is not patchable — a choice never changes column. */
export const UpdateTaskFieldOptionSchema = z.object({
    id: IdentifierSchema,
    label: TaskFieldLabelSchema.optional(),
    sort_order: SortOrderSchema.optional(),
});

/**
 * One task's answer for one column, as a task create/update body carries it.
 *
 * The value is always a string or `null` on the wire whatever the column's type, because the type is
 * chosen at runtime and a single shape keeps the body uniform. The server validates the string
 * against the column's declared type (and, for a `select`, against that column's own live choices).
 * `null` clears the answer.
 */
export const TaskFieldValueInputSchema = z.object({
    field_id: IdentifierSchema,
    value: z.string().max(2000, "Value must be 2000 characters or fewer").nullable(),
});

export type CreateTaskFieldInput = z.infer<typeof CreateTaskFieldSchema>;
export type UpdateTaskFieldInput = z.infer<typeof UpdateTaskFieldSchema>;
export type CreateTaskFieldOptionInput = z.infer<typeof CreateTaskFieldOptionSchema>;
export type UpdateTaskFieldOptionInput = z.infer<typeof UpdateTaskFieldOptionSchema>;
export type TaskFieldValueInput = z.infer<typeof TaskFieldValueInputSchema>;
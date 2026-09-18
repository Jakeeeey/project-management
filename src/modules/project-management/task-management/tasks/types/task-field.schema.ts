import { z } from "zod";

import { normalizeIconName } from "../components/catalog-icon";

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
 *
 * Two rules worth stating because they are not obvious from the shapes:
 * - **`default_value` is ONE value per column, not a flag per choice.** A Choice column defaults to
 *   one of its options, and the id of that option is what `default_value` holds; a text, number or
 *   date column holds its literal. A per-choice `is_default` flag alongside this would record the
 *   same fact twice and let the two disagree, so there is deliberately no such flag.
 * - **`is_enabled` is not `is_deleted`.** Disabling hides a column from the task list and the task
 *   form while keeping every stored answer, so it can be switched back on; removing retires it.
 */

export const TaskFieldTypeSchema = z.enum(["text", "number", "date", "select"]);

export type TaskFieldType = z.infer<typeof TaskFieldTypeSchema>;

/** Both `label` columns are `VARCHAR(100) NOT NULL`. Exported so the dialogs validate against the same rule the server enforces. */
export const TaskFieldLabelSchema = z
    .string()
    .trim()
    .min(1, "Label is required")
    .max(100, "Label must be 100 characters or fewer");

/** A 6-digit hex colour (`#16a34a`), rendered as an inline style — never a Tailwind class. */
export const TaskFieldColorSchema = z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, "Colour must be a 6-digit hex value such as #16a34a");

/**
 * A curated lucide icon name. `normalizeIconName` is both the validator and the normaliser: the
 * refine rejects a name outside the allow-list, and the transform stores the canonical spelling, so
 * `lucide-Circle` persists as `circle` and every reader downstream only ever sees a known name.
 */
export const TaskFieldIconSchema = z
    .string()
    .refine((value) => normalizeIconName(value) !== null, "Unknown icon")
    .transform((value) => normalizeIconName(value) ?? value);

/** Both tables store `sort_order INT NOT NULL DEFAULT 0`; every list orders by `(sort_order, id)`. */
const SortOrderSchema = z.number().int().min(0, "Sort order must be zero or greater");

/** Any `pm_task_field` / `pm_task_field_option` key in JS number range. */
const IdentifierSchema = z.number().int().positive();

/**
 * The two state columns a column carries, both optional so a PATCH can send either alone.
 *
 * `default_value` is `null` for "no default" — which is genuinely different from `undefined`, meaning
 * "leave the stored default alone". That distinction is what lets the form clear a default without
 * the update path reading a missing key as a clear.
 */
const FieldStateSchema = z.object({
    is_enabled: z.boolean().optional(),
    default_value: z.string().max(2000, "Default must be 2000 characters or fewer").nullable().optional(),
});

/** POST body for a new custom column. `sort_order` defaults to 0 server-side when omitted. */
export const CreateTaskFieldSchema = FieldStateSchema.extend({
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
    color: TaskFieldColorSchema.nullable().optional(),
    icon: TaskFieldIconSchema.nullable().optional(),
    sort_order: SortOrderSchema.optional(),
});

/** PATCH body for an existing choice. `field_id` is not patchable — a choice never changes column. */
export const UpdateTaskFieldOptionSchema = z.object({
    id: IdentifierSchema,
    label: TaskFieldLabelSchema.optional(),
    color: TaskFieldColorSchema.nullable().optional(),
    icon: TaskFieldIconSchema.nullable().optional(),
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
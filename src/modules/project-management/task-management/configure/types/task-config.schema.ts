import { z } from "zod";

/**
 * The catalog contracts for the task-configuration module — the ONLY definition of the
 * `pm_task_status` / `pm_task_priority` payload shapes in the repository.
 *
 * The two tables are separate (not one with a `kind` column) because `pm_task.status_id` and
 * `pm_task.priority_id` are foreign keys, and MySQL cannot enforce that an FK points at a row whose
 * discriminator equals a particular value. Both tables share the same column shape, so one schema
 * set describes both and `CatalogKindSchema` selects the table at runtime.
 *
 * Deliberate omissions:
 * - No `slug`: tasks reference a catalog row by primary key only, so there is exactly one
 *   identifier. There is also no unique key on either table, so nothing here can rely on one.
 * - No `is_deleted`, `department_id`, `created_by`, `updated_by`, `created_at` or `updated_at`:
 *   soft-delete is an action, and every audit column is injected server-side from the actor, so a
 *   client cannot set them. Zod strips unknown keys instead of failing, so a body carrying them is
 *   ignored rather than rejected.
 */

/** A 6-digit hex colour (e.g. `#16a34a`), rendered as an inline style — never a Tailwind class. */
const HexColorSchema = z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, "Color must be a 6-digit hex value such as #16a34a");

/** Both `label` columns are `VARCHAR(100) NOT NULL`. */
const LabelSchema = z.string().trim().min(1, "Label is required").max(100, "Label must be 100 characters or fewer");

/** Both tables store `sort_order INT NOT NULL DEFAULT 0`; every list orders by `(sort_order, id)`. */
const SortOrderSchema = z.number().int().min(0, "Sort order must be zero or greater");

/** Which catalog table a payload addresses — mandatory, because the two id spaces are independent. */
export const CatalogKindSchema = z.enum(["status", "priority"]);

/** POST body for a new status or priority. `sort_order` defaults to 0 server-side when omitted. */
export const CreateCatalogItemSchema = z.object({
    label: LabelSchema,
    color: HexColorSchema.nullable().optional(),
    sort_order: SortOrderSchema.optional(),
    is_default: z.boolean().optional(),
});

/**
 * PATCH body for an existing catalog row. Every field is optional: only what changed is written.
 *
 * `is_default: false` is accepted by the schema but is a no-op in the service — the flag is only
 * ever moved to another row, never cleared, because a kind must always resolve to a default.
 */
export const UpdateCatalogItemSchema = CreateCatalogItemSchema.partial();

export type CatalogKind = z.infer<typeof CatalogKindSchema>;
export type CreateCatalogItemInput = z.infer<typeof CreateCatalogItemSchema>;
export type UpdateCatalogItemInput = z.infer<typeof UpdateCatalogItemSchema>;

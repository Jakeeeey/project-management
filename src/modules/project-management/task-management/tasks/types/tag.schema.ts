import { z } from "zod";

/**
 * The tag contracts for the tasks module — the one definition of the `pm_tag` payload shape.
 *
 * A tag is a per-department catalog row (`pm_tag`) that a task references through `pm_task_tag`. It
 * is optional where a status is mandatory: a task carries zero or more tags, so the link table is
 * additive to the task payload rather than a foreign key on `pm_task`.
 *
 * Audit columns are absent for the same reason they are absent from `pm-task.schema`: the service
 * injects `department_id`, `created_by`, `updated_by` and both timestamps from the actor, so a body
 * carrying them is stripped rather than honoured.
 */

/** A 6-digit hex colour (e.g. `#16a34a`), rendered as an inline style — never a Tailwind class. */
const HexColorSchema = z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, "Color must be a 6-digit hex value such as #16a34a");

/** `pm_tag.id` and `pm_task_tag.tag_id` are `BIGINT UNSIGNED` in JS number range. */
const IdentifierSchema = z.number().int().positive();

/** `pm_tag.label` is `VARCHAR(100) NOT NULL`. */
const LabelSchema = z.string().trim().min(1, "Label is required").max(100, "Label must be 100 characters or fewer");

/** `pm_tag.sort_order INT NOT NULL DEFAULT 0`; every tag list orders by `(sort_order, id)`. */
const SortOrderSchema = z.number().int().min(0, "Sort order must be zero or greater");

/**
 * `pm_tag.icon VARCHAR(64) NULL`. Shape only: tags accept any lucide id, so there is no allow-list
 * here the way status and priority icons have one — only the stored length and a non-blank value.
 */
const IconSchema = z
    .string()
    .trim()
    .min(1, "Icon must not be blank")
    .max(64, "Icon must be 64 characters or fewer")
    .nullable()
    .optional();

/** POST body for a new department tag. */
export const CreateTagSchema = z.object({
    label: LabelSchema,
    color: HexColorSchema.nullable().optional(),
    sort_order: SortOrderSchema.optional(),
    icon: IconSchema,
});

/** PATCH body for an existing tag: every field is optional, only what changed is written. */
export const UpdateTagSchema = CreateTagSchema.partial();

/** Body for the task-tags route, both verbs: `{ tag_id }` attaches and detaches the same tag. */
export const TaskTagMutationSchema = z.object({
    tag_id: IdentifierSchema,
});

/** A tag as the API hands it to the UI. */
export interface TagWireRow {
    readonly id: number;
    readonly label: string;
    readonly color: string | null;
    readonly sort_order: number;
    readonly icon: string | null;
}

/** One tag on a task, as the tasks payload carries it — the id resolves through `catalogs.tags`. */
export interface TaskTagWireRef {
    readonly tag_id: number;
}

export type CreateTagInput = z.infer<typeof CreateTagSchema>;
export type UpdateTagInput = z.infer<typeof UpdateTagSchema>;
export type TaskTagMutationInput = z.infer<typeof TaskTagMutationSchema>;

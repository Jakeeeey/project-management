import { z } from "zod";

/**
 * The list contracts for the task-management module — the ONLY definition of the `pm_task_list`
 * payload shapes in the repository.
 *
 * Deliberate omissions:
 * - No `is_default`: the default list is the department's backfilled "General" row, and the flag is
 *   server-owned so a client can never move or clear the one list a task falls back to.
 * - No `is_deleted`, `department_id`, `created_by`, `updated_by`, `created_at` or `updated_at`:
 *   soft-delete is an action, and every audit column is injected server-side from the actor, so a
 *   client cannot set them. Zod strips unknown keys instead of failing, so a body carrying them is
 *   ignored rather than honoured.
 */

/** `pm_task_list.name` is `VARCHAR(100) NOT NULL` — the same bound the catalog labels carry. */
const NameSchema = z.string().trim().min(1, "Name is required").max(100, "Name must be 100 characters or fewer");

/** `sort_order INT NOT NULL DEFAULT 0`; every list orders by `(sort_order, id)`. */
const SortOrderSchema = z.number().int().min(0, "Sort order must be zero or greater");

/** POST body for a new task list. `sort_order` defaults to 0 server-side when omitted. */
export const CreateTaskListSchema = z.object({
    name: NameSchema,
    sort_order: SortOrderSchema.optional(),
});

/** PATCH body for an existing list: rename and reorder only, and only what changed. */
export const UpdateTaskListSchema = CreateTaskListSchema.partial();

export type CreateTaskListInput = z.infer<typeof CreateTaskListSchema>;
export type UpdateTaskListInput = z.infer<typeof UpdateTaskListSchema>;

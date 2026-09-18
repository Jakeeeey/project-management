import { z } from "zod";

import { TaskFieldValueInputSchema } from "./task-field.schema";

/**
 * Task contracts for the tasks module.
 *
 * Statuses and priorities are DATA, not enums: `pm_task_status` and `pm_task_priority` are
 * per-department catalog tables that `pm_task` references by foreign key, so no status or priority
 * value is declared here (or anywhere outside the configuration service's seed fixture).
 *
 * Audit columns are deliberately absent from every schema: `department_id`, `created_by`,
 * `updated_by`, `created_at` and `updated_at` are injected server-side from the actor, so a client
 * cannot set them. Zod strips unknown keys instead of failing, which is why a body carrying them
 * is ignored rather than rejected.
 */

/** `YYYY-MM-DD` — `pm_task.start_date` / `end_date` are DATE columns, not timestamps. */
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

/** Any `pm_task` key or a `user.user_id` in JS number range (`BIGINT UNSIGNED` / `INT` in MySQL). */
const IdentifierSchema = z.number().int().positive();

/**
 * POST body for creating a task or a subtask.
 *
 * `parent_id` belongs here (a subtask is created under its parent) but NOT in `UpdateTaskSchema`:
 * a PATCH must never reshape the tree — re-parenting goes through the move route, which owns the
 * cycle guard and the sibling renumbering.
 */
export const CreateTaskSchema = z.object({
    title: z.string().trim().min(1, "Title is required").max(255, "Title must be 255 characters or fewer"),
    description: z.string().nullable().optional(),
    parent_id: IdentifierSchema.nullable().optional(),
    /**
     * The task's list. A root task may name any live list of the actor's department; omitted, it
     * falls back to the department's default list. A subtask may name only its parent's list —
     * omitted, it inherits it — so a subtree can never be split across lists.
     */
    list_id: IdentifierSchema.nullable().optional(),
    /** Catalog row of the actor's department; `null`/omitted falls back to that kind's default row. */
    status_id: IdentifierSchema.nullable().optional(),
    priority_id: IdentifierSchema.nullable().optional(),
    start_date: DateOnlySchema.nullable().optional(),
    end_date: DateOnlySchema.nullable().optional(),
    /**
     * The task's answers for the department's custom columns. Only the columns named here are
     * written, so an update that omits the key leaves every stored answer untouched; a named column
     * with `value: null` clears that one answer. A column id the actor's department does not have is
     * a 400, never a silently ignored key.
     */
    custom_values: z.array(TaskFieldValueInputSchema).max(100, "A task cannot carry more than 100 custom answers").optional(),
});

/**
 * PATCH body for editing a task's fields. Every field is optional (only what changed is written),
 * and `parent_id` is excluded by construction — see `CreateTaskSchema`.
 *
 * `list_id` IS accepted here, but only so the service can REJECT a differing value with a clear
 * 400: a task's list is fixed by its place in the tree, and a plain edit must never be able to
 * split a subtree across lists.
 */
export const UpdateTaskSchema = CreateTaskSchema.omit({ parent_id: true }).partial();

/**
 * The destination parent's COMPLETE ordered child list after the move, as the client computed it.
 *
 * `parent_id: null` means "move to root" and is valid; it is not the same as a missing parent.
 * A duplicate would leave two siblings with the same `sort_order` index, so the array rejects
 * duplicates here rather than letting the route renumber from a corrupt list.
 */
export const MoveTaskSchema = z.object({
    parent_id: IdentifierSchema.nullable(),
    sibling_ids: z
        .array(IdentifierSchema)
        .min(1, "sibling_ids must include the moved task")
        .refine((ids) => new Set(ids).size === ids.length, {
            message: "sibling_ids must not contain duplicates",
        }),
});

/**
 * Body for the assignees route, both verbs: `{ user_id }` assigns (revive-or-insert) and unassigns
 * (soft delete). A grant check and a department check still follow on the server.
 */
export const AssigneeMutationSchema = z.object({
    user_id: IdentifierSchema,
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type MoveTaskInput = z.infer<typeof MoveTaskSchema>;
export type AssigneeMutationInput = z.infer<typeof AssigneeMutationSchema>;

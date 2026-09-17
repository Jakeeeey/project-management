import { z } from "zod";

/**
 * The grant and revoke contracts for the assignment-grants module.
 *
 * Two payloads, two identifiers, deliberately distinct:
 * - a GRANT names the member (`user_id`) whose row should become active;
 * - a REVOKE names the granted ROW (`id`) that should be soft-deleted, because the grant table is
 *   the thing being mutated and its id is what the list returns per member.
 *
 * Neither payload carries `department_id`, and neither carries an audit field: the department is
 * always the actor's own, resolved server-side, and `granted_by` / `created_by` / `updated_by` /
 * timestamps are injected from that actor. Zod strips unknown keys instead of failing, so a body
 * attempting to smuggle them is ignored rather than honoured.
 *
 * There is no "self" or "head" value here either: granting is head-only and that decision is made by
 * `assertCanGrant` against the actor's resolved department row, never by a client-supplied flag.
 */

/** POST body: the department member to grant assigner rights to. */
export const GrantAssignerSchema = z.object({
    user_id: z.number().int().positive(),
});

/** DELETE body: the `pm_task_assigner` row to soft-delete. */
export const RevokeAssignerSchema = z.object({
    id: z.number().int().positive(),
});

export type GrantAssignerInput = z.infer<typeof GrantAssignerSchema>;
export type RevokeAssignerInput = z.infer<typeof RevokeAssignerSchema>;

import { z } from "zod";

/**
 * The capability payload the server resolves for the signed-in actor and the client only renders.
 *
 * It lives in the module-root `types/` spine rather than a feature's own `types/` because more than
 * one module reads it: the tasks routes return it, and the task-configuration section hides itself
 * when `canConfigure` is false.
 *
 * Two deliberate omissions:
 * - No `canEditThisTask(task)` / `canDeleteThisTask(task)`: those answers need the row, so they stay
 *   server-side predicates and reach the client as the server-computed `can_edit` / `can_delete`
 *   flags on every task row. The coarse `canEdit` / `canDelete` below are the session-level answers.
 * - No role claim: these flags are derived from department headship and the task-access table,
 *   never from an `isAdmin`/`role === ...` string (conventions.md section 11).
 *
 * The matrix these mirror (head / granted member / plain member). The department's
 * `allow_all_members_grant` setting — surfaced as "Allow all members Edit access" — moves SEVEN of
 * the eight flags:
 * - with it OFF: view and create are open to every member, while edit, assign, configure and delete
 *   are head-or-granted, and both grant and manage-setting are head-only;
 * - with it ON (the default, including when no setting row exists): all of those open to every
 *   member EXCEPT `canManageDepartmentSetting`, which stays head-only in both policies — so the
 *   people the policy empowers can never change it.
 * Edit and delete additionally carry a per-row creator exception, applied where the row is known,
 * which is why the payload carries `can_edit` / `can_delete` alongside these coarse flags.
 */
export const CapabilitiesSchema = z.object({
    canView: z.boolean(),
    canCreate: z.boolean(),
    /**
     * Coarse answer ("head, granted, or the policy is ON"); the authoritative per-row flag is
     * `can_edit`.
     */
    canEdit: z.boolean(),
    canAssign: z.boolean(),
    /**
     * Coarse answer ("head, granted, or the policy is ON"); the authoritative per-row flag is
     * `can_delete`.
     */
    canDelete: z.boolean(),
    canGrant: z.boolean(),
    canConfigure: z.boolean(),
    /** Head-only: may change the department's access policy (the members-may-grant toggle). */
    canManageDepartmentSetting: z.boolean(),
});

export type Capabilities = z.infer<typeof CapabilitiesSchema>;

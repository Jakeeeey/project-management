import { z } from "zod";

/**
 * The capability payload the server resolves for the signed-in actor and the client only renders.
 *
 * It lives in the module-root `types/` spine rather than a feature's own `types/` because more than
 * one module reads it: the tasks routes return it, and the task-configuration section hides itself
 * when `canConfigure` is false.
 *
 * Two deliberate omissions:
 * - No `canDeleteThisTask(task)`: that answer needs the row, so it stays a server-side predicate
 *   and reaches the client as the server-computed `can_delete` flag on every task row.
 * - No role claim: these flags are derived from department headship and the assigner-grant table,
 *   never from an `isAdmin`/`role === ...` string (conventions.md section 11).
 *
 * The matrix these mirror (head / granted assigner / plain member):
 * view, create and edit are open to every member; assign is head-or-granted; delete is
 * head-or-granted with a creator exception applied per row; configure is head-or-granted (the
 * recorded decision that couples config editing to the grant). Grant is head-or-open-policy: where
 * a department's `allow_all_members_grant` setting is ON (its default, including when no setting row
 * exists), every member may grant. The one head-only flag is `canManageDepartmentSetting`, which
 * gates that policy itself — so a member who may grant can never change the policy that lets them.
 */
export const CapabilitiesSchema = z.object({
    canView: z.boolean(),
    canCreate: z.boolean(),
    canEdit: z.boolean(),
    canAssign: z.boolean(),
    /** Coarse answer ("head or granted assigner"); the authoritative per-row flag is `can_delete`. */
    canDelete: z.boolean(),
    canGrant: z.boolean(),
    canConfigure: z.boolean(),
    /** Head-only: may change the department's assignment-grant policy (the members-may-grant toggle). */
    canManageDepartmentSetting: z.boolean(),
});

export type Capabilities = z.infer<typeof CapabilitiesSchema>;

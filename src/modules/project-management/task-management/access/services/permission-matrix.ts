/**
 * The pure core of the permission evaluator — the Permission Matrix as total functions.
 *
 * The matrix, in words (head / granted member / plain member). Two inputs decide everything: whether
 * the department's `allow_all_members_grant` policy is ON, and whether this actor holds a grant.
 *
 * With the policy OFF:
 * - view and create are open to every member;
 * - edit, assign, configure and delete are head-or-granted;
 * - grant and manage-setting are head-only.
 *
 * With the policy ON (the default for a department with no setting row):
 * - every one of those opens to every member EXCEPT `manage-setting`, which stays head-only in both
 *   policies — so a member who may grant can never change the policy that lets them. That is the
 *   point of the exception: the toggle must never be reachable by the people it empowers.
 * - The policy is what "Allow all members Edit access" MEANS. ON gives every member Edit access
 *   outright, rather than merely the right to grant it to each other — which is why the Access page
 *   greys out the whole per-member grant control while it is on. Individually granting a colleague
 *   something they already have would be a no-op, and offering it would misrepresent the rule.
 *
 * "edit" is the capability this module is named after: it covers everything a task edit can change —
 * title, description, status, priority, dates, custom fields and assignees. Assign, configure and
 * delete are facets of it rather than separate rights, so they all delegate to `canEditFrom`; they
 * are named separately only so a future divergence has an obvious home.
 *
 * Two row-aware answers are easy to conflate, so each is TWO functions and not one:
 * - `canEditFrom` / `canDeleteFrom` are the COARSE flags the capability payload carries
 *   ("head, granted, or the policy is open");
 * - `canEditTaskFrom` / `canDeleteTaskFrom` are the row-aware answers the server computes per task,
 *   which additionally admit the row's creator — so a member who raised a task can always finish it,
 *   even with the policy OFF and no grant.
 *
 * This file imports nothing and uses only erasable syntax (no enum, no namespace, no parameter
 * properties) so `services/__assert.ts` can load it through Node's native type stripping — the same
 * arrangement `department-scope.ts` has with that harness.
 */

/** The capabilities the matrix decides — one per row of the plan's Permission Matrix, plus the policy toggle. */
export type Capability = "view" | "create" | "edit" | "assign" | "delete" | "configure" | "grant" | "manage-setting";

/** The role and policy facts every capability is evaluated from. */
export interface RoleFacts {
    /** The actor's own `department` row names them as `department_head_id`. */
    readonly isHead: boolean;
    /** A live `pm_task_access` row exists for this actor in their department. */
    readonly hasGrant: boolean;
    /**
     * The department's `pm_task_department_setting.allow_all_members_grant` — the "Allow all members
     * Edit access" switch. When true, every member HAS Edit access (and may grant it); when false,
     * only the head and individually granted members do. An ABSENT setting row resolves to true, so a
     * department that never opened the toggle is permissive by default.
     */
    readonly allowAllMembersGrant: boolean;
}

/** `RoleFacts` plus the per-row fact the row-aware edit and delete answers add. */
export interface TaskRowFacts extends RoleFacts {
    /** The task row's `created_by` equals the actor's user id. */
    readonly isCreator: boolean;
}

/** Thrown by the assertion helpers when the matrix refuses an action. Routes map it to a 403. */
export class PermissionError extends Error {
    readonly code = "FORBIDDEN";

    constructor(message: string = "FORBIDDEN: Actor lacks the required capability") {
        super(message);
        this.name = "PermissionError";
    }
}

/**
 * The one rule behind every gated task action: the head is implicitly capable and needs no grant
 * row, a granted member is capable through the `pm_task_access` table, and — while the department's
 * "Allow all members Edit access" policy is ON — every member is capable outright.
 *
 * That last clause is what the policy MEANS. It is not merely permission to grant; an open policy
 * gives every member Edit access directly, which is why the Access page greys out the per-member
 * grant control while it is on.
 *
 * This is the capability the module is named after. Assigning, configuring and deleting are all
 * facets of working on a department's tasks rather than independent rights, so each of the three
 * functions below delegates here — they are named separately so a future divergence has an obvious
 * home, not because they differ today.
 */
export function canEditFrom(facts: RoleFacts): boolean {
    return facts.isHead || facts.hasGrant || facts.allowAllMembersGrant;
}

/** Assign or unassign: part of editing a task, so the same rule. */
export function canAssignFrom(facts: RoleFacts): boolean {
    return canEditFrom(facts);
}

/** Editing the department's status / priority catalogs and custom columns: the same rule. */
export function canConfigureFrom(facts: RoleFacts): boolean {
    return canEditFrom(facts);
}

/**
 * Granting and revoking Edit access: the head may always do it, and the department's
 * `allowAllMembersGrant` setting opens the same right to every member while it is ON. A member is
 * therefore only a grantor while the policy allows it — and never able to change that policy, which
 * is the separate `manage-setting` capability below.
 */
export function canGrantFrom(facts: RoleFacts): boolean {
    return facts.isHead || facts.allowAllMembersGrant;
}

/** Changing the department's access policy is head-only, always — no setting opens it. */
export function canManageSettingFrom(facts: RoleFacts): boolean {
    return facts.isHead;
}

/**
 * The COARSE delete flag: may this role delete ANY task in the department? Head or granted member.
 * The creator exception is per row and lives in `canDeleteTaskFrom`.
 */
export function canDeleteFrom(facts: RoleFacts): boolean {
    return canEditFrom(facts);
}

/** The row-aware edit answer: anyone the coarse flag admits, plus the task's own creator. */
export function canEditTaskFrom(facts: TaskRowFacts): boolean {
    return canEditFrom(facts) || facts.isCreator;
}

/** The row-aware delete answer: anyone the coarse flag admits, plus the task's own creator. */
export function canDeleteTaskFrom(facts: TaskRowFacts): boolean {
    return canDeleteFrom(facts) || facts.isCreator;
}

/** Compile-time exhaustiveness guard: an unhandled capability is a type error, never a silent `false`. */
function assertNever(value: never): never {
    throw new Error(`Unhandled capability: ${String(value)}`);
}

/**
 * The whole matrix in one call: capability in, flag out.
 *
 * `edit` and `delete` are the COARSE flags (matching the capability payload); `canEditTaskFrom` and
 * `canDeleteTaskFrom` are the row-aware twins the server uses for each task's `can_edit` and
 * `can_delete`.
 */
export function allows(capability: Capability, facts: RoleFacts): boolean {
    switch (capability) {
        case "view":
        case "create":
            return true;
        case "edit":
            return canEditFrom(facts);
        case "assign":
            return canAssignFrom(facts);
        case "delete":
            return canDeleteFrom(facts);
        case "configure":
            return canConfigureFrom(facts);
        case "grant":
            return canGrantFrom(facts);
        case "manage-setting":
            return canManageSettingFrom(facts);
        default:
            return assertNever(capability);
    }
}

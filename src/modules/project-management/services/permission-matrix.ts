/**
 * The pure core of the permission evaluator — the Permission Matrix as total functions.
 *
 * The matrix, in words (head / granted assigner / plain member):
 * - view, create and edit (which includes reorder and re-parent) are open to every member;
 * - assign and configure are head-or-granted — the head implicitly, with no grant row;
 * - grant is head-only, so a granted assigner can never grant;
 * - delete is head-or-granted with a per-row creator exception.
 *
 * Two delete answers are easy to conflate, so they are two functions and not one:
 * - `canDeleteFrom` is the COARSE flag the capability payload carries ("head or granted assigner");
 * - `canDeleteTaskFrom` is the row-aware answer the server computes per task, which additionally
 *   admits the row's creator.
 *
 * This file imports nothing and uses only erasable syntax (no enum, no namespace, no parameter
 * properties) so `services/__assert.ts` can load it through Node's native type stripping — the same
 * arrangement `department-scope.ts` has with that harness.
 */

/** The capabilities the matrix decides — one per row of the plan's Permission Matrix. */
export type Capability = "view" | "create" | "edit" | "assign" | "delete" | "configure" | "grant";

/** The two role facts every capability is evaluated from. */
export interface RoleFacts {
    /** The actor's own `department` row names them as `department_head_id`. */
    readonly isHead: boolean;
    /** A live `pm_task_assigner` row exists for this actor in their department. */
    readonly hasGrant: boolean;
}

/** `RoleFacts` plus the per-row fact the row-aware delete answer adds. */
export interface DeleteFacts extends RoleFacts {
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
 * Assign or unassign: the head is implicitly capable and needs no grant row; a granted assigner is
 * capable through the table; a plain member is not.
 */
export function canAssignFrom(facts: RoleFacts): boolean {
    return facts.isHead || facts.hasGrant;
}

/**
 * Editing the status / priority catalog is deliberately coupled to the assigner grant (the plan's
 * recorded decision, not an accident): the head may always configure, a granted assigner may too,
 * and a plain member never may.
 */
export function canConfigureFrom(facts: RoleFacts): boolean {
    return facts.isHead || facts.hasGrant;
}

/** Granting and revoking is head-only — a granted assigner can never grant. */
export function canGrantFrom(facts: RoleFacts): boolean {
    return facts.isHead;
}

/**
 * The COARSE delete flag: may this role delete ANY task in the department? Head or granted
 * assigner. The creator exception is per row and lives in `canDeleteTaskFrom`.
 */
export function canDeleteFrom(facts: RoleFacts): boolean {
    return facts.isHead || facts.hasGrant;
}

/** The row-aware delete answer: anyone the coarse flag admits, plus the task's own creator. */
export function canDeleteTaskFrom(facts: DeleteFacts): boolean {
    return canDeleteFrom(facts) || facts.isCreator;
}

/** Compile-time exhaustiveness guard: an unhandled capability is a type error, never a silent `false`. */
function assertNever(value: never): never {
    throw new Error(`Unhandled capability: ${String(value)}`);
}

/**
 * The whole matrix in one call: capability in, flag out.
 *
 * `delete` is the coarse flag (matching the capability payload); `canDeleteTaskFrom` is the
 * row-aware twin the server uses for each task's `can_delete`.
 */
export function allows(capability: Capability, facts: RoleFacts): boolean {
    switch (capability) {
        case "view":
        case "create":
        case "edit":
            return true;
        case "assign":
            return canAssignFrom(facts);
        case "delete":
            return canDeleteFrom(facts);
        case "configure":
            return canConfigureFrom(facts);
        case "grant":
            return canGrantFrom(facts);
        default:
            return assertNever(capability);
    }
}

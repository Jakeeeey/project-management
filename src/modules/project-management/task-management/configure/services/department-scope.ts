/**
 * The pure core of the department-scoping invariant.
 *
 * Policy: a row is reachable only through its own department. The comparison is value-based — it
 * compares `department_id` data, not a role string — and a nullish value on either side never
 * matches, which is what makes a scoped lookup a 404 and a user without a department a hard 403 at
 * the route layer instead of an unscoped query.
 *
 * This file imports nothing and uses only erasable syntax (no enum, no namespace, no parameter
 * properties) so `services/__assert.ts` can load it through Node's native type stripping — the same
 * arrangement `utils/tree.ts` and `utils/ph-time.ts` have with `utils/__assert.ts`.
 */

/**
 * The minimum a row must expose to be scoped. `unknown` on purpose: a row coming from Directus is
 * shaped at runtime (a nested `is_deleted` can be a Buffer, a string or a number), and the
 * predicate must stay total for every shape instead of trusting one.
 */
export interface DepartmentScopedRow {
    readonly department_id?: unknown;
}

/**
 * Answers "does this row belong to this department?".
 *
 * `false` when either side is nullish: an absent row department and an absent actor department are
 * both "not the same department", so neither can widen a query or satisfy a guard.
 *
 * @param row          The row under test; `null`/`undefined` rows are rejected rather than thrown on.
 * @param departmentId The actor's resolved department, or `null` when the actor has none.
 */
export function isSameDepartment(
    row: DepartmentScopedRow | null | undefined,
    departmentId: number | null | undefined,
): boolean {
    if (row === null || row === undefined) return false;
    if (departmentId === null || departmentId === undefined) return false;

    const rowDepartment = row.department_id;
    if (rowDepartment === null || rowDepartment === undefined) return false;

    return Number(rowDepartment) === Number(departmentId);
}

/** Thrown when a row that did not come through a department-scoped loader belongs elsewhere. */
export class DepartmentScopeError extends Error {
    readonly code = "NOT_FOUND";

    constructor(message: string = "NOT_FOUND: Row is not in the actor's department") {
        super(message);
        this.name = "DepartmentScopeError";
    }
}

/**
 * Guards a row that reached the module through a path without the department filter — typically a
 * task's `parent_id` target, loaded so its department can be validated before a move.
 *
 * The caller maps the throw to the response its contract names (a 400 for a bad parent, a 404 for a
 * subject row); the point is that the mismatch is always refused, never written through.
 */
export function assertSameDepartment(
    actor: { readonly departmentId: number | null },
    row: DepartmentScopedRow,
): void {
    if (!isSameDepartment(row, actor.departmentId)) throw new DepartmentScopeError();
}

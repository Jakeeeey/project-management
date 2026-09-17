/**
 * The pure core of the task-configuration catalog policy.
 *
 * Three rules decide every catalog write, and each is a total function here so it can be asserted
 * without a database:
 * - a duplicate LABEL among the department's LIVE rows is rejected — the catalogs deliberately carry
 *   no unique key, so this is an explicit read-then-write check, not a DB constraint;
 * - a kind always resolves to an effective default: the live row flagged `is_default`, else the
 *   lowest `(sort_order, id)` live row, so a missing flag can never strand task creation;
 * - catalog rows are only ever soft-deleted, and never the last live row of a kind nor the row that
 *   currently serves as its default.
 *
 * This file imports nothing and uses only erasable syntax (no enum, no namespace, no parameter
 * properties) so `services/__assert.ts` can load it through Node's native type stripping — the same
 * arrangement `department-scope.ts` and `permission-matrix.ts` have with that harness.
 */

/**
 * The minimum a catalog row must expose to be judged. `unknown` on the two flags on purpose: a
 * `TINYINT(1)` arrives from Directus as a number, a string, a boolean or a byte buffer depending on
 * the payload shape, and the predicates must stay total for every shape instead of trusting one.
 */
export interface CatalogRow {
    readonly id: number;
    readonly label: string;
    readonly sort_order: number;
    readonly is_default: unknown;
    readonly is_deleted: unknown;
}

/** The coded failure kinds the catalog service throws. Routes map them to 400 / 404 / 500. */
export type TaskConfigErrorCode = "VALIDATION_FAILED" | "NOT_FOUND" | "INTERNAL_FAIL";

/**
 * The table each kind lives in — a schema fact, kept here so the service and the seed writer resolve
 * a kind to the same collection. The two tables have independent id spaces, never one table.
 */
export const CONFIG_COLLECTIONS: Record<"status" | "priority", string> = {
    status: "pm_task_status",
    priority: "pm_task_priority",
};

/** A catalog-rule refusal, carrying the `CODE: message` shape conventions section 13 pins. */
export class TaskConfigError extends Error {
    readonly code: TaskConfigErrorCode;

    constructor(code: TaskConfigErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "TaskConfigError";
        this.code = code;
    }
}

/**
 * Reads a `TINYINT(1)` flag in every shape Directus can hand back: `true` and non-zero numbers are
 * true, `0`, `"0"` and `"false"` are false, and a byte buffer holding `1` or its ASCII form (`0x31`)
 * is true. Anything else (including `null`/`undefined`) is false.
 */
export function isTrueFlag(value: unknown): boolean {
    if (value === true) return true;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
    if (value instanceof Uint8Array) return value.some((byte) => byte === 1 || byte === 0x31);
    return false;
}

/** The live (not soft-deleted) rows of the given set. */
export function liveRows<T extends CatalogRow>(rows: readonly T[]): T[] {
    return rows.filter((row) => !isTrueFlag(row.is_deleted));
}

/** The catalog ordering contract: `sort_order` first, `id` as the stable tie-break. */
export function sortCatalogRows<T extends CatalogRow>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

/** Labels compare trimmed and case-insensitively: `Todo` and `todo` are one label to a human. */
function normaliseLabel(label: string): string {
    return label.trim().toLowerCase();
}

/**
 * The live row that already carries this label, if any — the duplicate the service rejects with a
 * 400. `excludeId` lets an update keep a row's own label (including a case-only edit).
 *
 * Soft-deleted rows are invisible here, so deleting a row and later adding a similarly named one
 * can never raise a duplicate: the catalog deliberately carries no unique key.
 */
export function duplicateLabelRow<T extends CatalogRow>(
    rows: readonly T[],
    label: string,
    excludeId?: number,
): T | null {
    const wanted = normaliseLabel(label);
    let match: T | null = null;
    for (const row of liveRows(rows)) {
        if (excludeId !== undefined && row.id === excludeId) continue;
        if (normaliseLabel(row.label) !== wanted) continue;
        if (match === null || row.id < match.id) match = row;
    }
    return match;
}

/**
 * The row a kind actually falls back to when a task omits its status or priority: the live row
 * flagged `is_default`, else the lowest `(sort_order, id)` live row. `null` only when the kind has
 * no live rows at all — the one case that legitimately blocks task creation.
 *
 * Two flagged rows (the accepted read-then-write residual) resolve deterministically to the lowest,
 * and the service re-normalises on its next write.
 */
export function effectiveDefaultRow<T extends CatalogRow>(rows: readonly T[]): T | null {
    const live = sortCatalogRows(liveRows(rows));
    return live.find((row) => isTrueFlag(row.is_default)) ?? live[0] ?? null;
}

/** Why a catalog row may not be soft-deleted. */
export type DeleteRefusal = "not-found" | "last-live-row" | "current-default";

/**
 * Judges a soft-delete. Refusals, in precedence order:
 * - `not-found` — the id is not among the kind's live rows (the route answers 404);
 * - `last-live-row` — deleting it would leave the kind with no rows at all;
 * - `current-default` — it is the row `effectiveDefaultRow` resolves to.
 *
 * `null` means the delete is allowed.
 */
export function deleteRefusal(rows: readonly CatalogRow[], targetId: number): DeleteRefusal | null {
    const live = liveRows(rows);
    if (!live.some((row) => row.id === targetId)) return "not-found";
    if (live.length <= 1) return "last-live-row";
    if (effectiveDefaultRow(rows)?.id === targetId) return "current-default";
    return null;
}

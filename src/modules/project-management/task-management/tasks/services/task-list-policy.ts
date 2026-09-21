/**
 * The pure core of the task-list policy.
 *
 * Four rules decide every list write, and each is a total function here so it can be asserted
 * without a database:
 * - a duplicate NAME among the department's LIVE lists is rejected — `pm_task_list` carries no
 *   unique key, so this is an explicit read-then-write check, not a DB constraint;
 * - a department always resolves to an effective default list: the live row flagged `is_default`,
 *   else the lowest `(sort_order, id)` live row, so a missing flag can never strand task creation;
 * - lists are only ever soft-deleted, and never the last live list of a department nor the row that
 *   currently serves as its default;
 * - a task's list is REQUIRED and a subtask must share its parent's list — the exclusivity
 *   predicate `isListCompatible` is what both the create path and the move path enforce, so the
 *   rule has exactly one implementation.
 *
 * This file imports nothing and uses only erasable syntax (no enum, no namespace, no parameter
 * properties) so `./__assert.ts` can load it through Node's native type stripping — the same
 * arrangement `./task-move-rules.ts` and `../../configure/services/task-config-policy.ts` have
 * with that harness.
 */

/**
 * The minimum a list row must expose to be judged. `unknown` on the two flags on purpose: a
 * `TINYINT(1)` arrives from Directus as a number, a string, a boolean or a byte buffer depending on
 * the payload shape, and the predicates must stay total for every shape instead of trusting one.
 */
export interface ListRow {
    readonly id: number;
    readonly name: string;
    readonly sort_order: number;
    readonly is_default: unknown;
    readonly is_deleted: unknown;
}

/** The coded failure kinds the list service throws. Routes map them to 400 / 404 / 500. */
export type TaskListErrorCode = "VALIDATION_FAILED" | "NOT_FOUND" | "INTERNAL_FAIL";

/** A list-rule refusal, carrying the `CODE: message` shape conventions section 13 pins. */
export class TaskListError extends Error {
    readonly code: TaskListErrorCode;

    constructor(code: TaskListErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "TaskListError";
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
export function liveListRows<T extends ListRow>(rows: readonly T[]): T[] {
    return rows.filter((row) => !isTrueFlag(row.is_deleted));
}

/** The list ordering contract: `sort_order` first, `id` as the stable tie-break. */
export function sortListRows<T extends ListRow>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

/** Names compare trimmed and case-insensitively: `General` and `general` are one name to a human. */
function normaliseName(name: string): string {
    return name.trim().toLowerCase();
}

/**
 * The live row that already carries this name, if any — the duplicate the service rejects with a
 * 400. `excludeId` lets an update keep a row's own name (including a case-only edit).
 *
 * Soft-deleted rows are invisible here, so deleting a list and later adding a similarly named one
 * can never raise a duplicate: the table deliberately carries no unique key.
 */
export function duplicateNameRow<T extends ListRow>(
    rows: readonly T[],
    name: string,
    excludeId?: number,
): T | null {
    const wanted = normaliseName(name);
    let match: T | null = null;
    for (const row of liveListRows(rows)) {
        if (excludeId !== undefined && row.id === excludeId) continue;
        if (normaliseName(row.name) !== wanted) continue;
        if (match === null || row.id < match.id) match = row;
    }
    return match;
}

/**
 * The list a department actually falls back to when a task omits its list: the live row flagged
 * `is_default`, else the lowest `(sort_order, id)` live row. `null` only when the department has no
 * live list at all — the one case that legitimately blocks task creation.
 *
 * Two flagged rows (the accepted read-then-write residual) resolve deterministically to the lowest,
 * and the service re-normalises on its next write.
 */
export function effectiveDefaultList<T extends ListRow>(rows: readonly T[]): T | null {
    const live = sortListRows(liveListRows(rows));
    return live.find((row) => isTrueFlag(row.is_default)) ?? live[0] ?? null;
}

/** Why a list may not be soft-deleted. */
export type ListDeleteRefusal = "not-found" | "last-live-row" | "current-default";

/**
 * Judges a soft-delete. Refusals, in precedence order:
 * - `not-found` — the id is not among the department's live lists (the route answers 404);
 * - `last-live-row` — deleting it would leave the department with no list at all;
 * - `current-default` — it is the list `effectiveDefaultList` resolves to, which is protected so a
 *   department can never lose the fallback its tasks land in.
 *
 * `null` means the delete is allowed.
 */
export function deleteListRefusal(rows: readonly ListRow[], targetId: number): ListDeleteRefusal | null {
    const live = liveListRows(rows);
    if (!live.some((row) => row.id === targetId)) return "not-found";
    if (live.length <= 1) return "last-live-row";
    if (effectiveDefaultList(rows)?.id === targetId) return "current-default";
    return null;
}

/**
 * The subtask/list exclusivity predicate: a task may only sit under a parent whose list matches.
 *
 * A `null` on either side imposes nothing — a root task has no parent list to compare against, and
 * a row that predates the column has no list to enforce — so the predicate stays total and a
 * pre-lists tree is never retroactively refused. Both the create path and the move path call this,
 * so "a subtask's list must equal its parent's list" has one implementation.
 */
export function isListCompatible(parentListId: number | null, candidateListId: number | null): boolean {
    return parentListId === null || candidateListId === null || parentListId === candidateListId;
}

/** The inputs `resolveTaskListId` decides from. */
export interface TaskListResolutionInput {
    /** The department's list rows; soft-deleted ones are ignored. */
    readonly lists: readonly ListRow[];
    /** The list id the request named, or `null` when it named none. */
    readonly requestedListId: number | null;
    /** The resolved parent's list id, or `null` when the task has no parent. */
    readonly parentListId: number | null;
}

/**
 * The task-creation list resolution, as a tagged result so the service can map each refusal to its
 * own 400 message:
 * - a requested list that is not one of the department's live lists is `unknown-list` (never a
 *   foreign-key 500, and never a confirmation that another department's list exists);
 * - with a parent, an explicit list that differs from the parent's is `subtask-list-mismatch`; an
 *   omitted one INHERITS the parent's list, because falling back to the default would split the
 *   subtree;
 * - a root task takes the requested list, else the effective default;
 * - `no-list` means the department has no live list at all — the documented clear 400.
 */
export type ListResolution =
    | { readonly kind: "resolved"; readonly listId: number }
    | { readonly kind: "unknown-list"; readonly requestedListId: number }
    | {
          readonly kind: "subtask-list-mismatch";
          readonly parentListId: number;
          readonly requestedListId: number;
      }
    | { readonly kind: "no-list" };

export function resolveTaskListId(input: TaskListResolutionInput): ListResolution {
    const { lists, requestedListId, parentListId } = input;
    const live = liveListRows(lists);

    if (requestedListId !== null && !live.some((row) => row.id === requestedListId)) {
        return { kind: "unknown-list", requestedListId };
    }

    if (parentListId !== null) {
        if (requestedListId !== null && !isListCompatible(parentListId, requestedListId)) {
            return { kind: "subtask-list-mismatch", parentListId, requestedListId };
        }
        return { kind: "resolved", listId: parentListId };
    }

    if (requestedListId !== null) return { kind: "resolved", listId: requestedListId };

    const fallback = effectiveDefaultList(live);
    return fallback === null ? { kind: "no-list" } : { kind: "resolved", listId: fallback.id };
}

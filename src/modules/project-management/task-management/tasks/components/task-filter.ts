import type { TaskField } from "../hooks/useTasks";
import type { TaskTreeRow } from "../hooks/useTaskTree";

/**
 * The tasks filter model: the clause the builder edits, the predicate that decides whether a row
 * satisfies it, and the per-user localStorage store of saved clause sets.
 *
 * A filter is an ARRAY OF CLAUSES combined with **AND**. Each clause is `[field] [operator] [value]`,
 * where `fieldKey` is `"status"`, `"priority"`, `"assignee"` or `"field:<id>"` for a custom column,
 * and `value` is the field's STORED string form (an option id for a Choice, `YYYY-MM-DD` for a date).
 * A clause is ACTIVE only when it names a field and — for a value-taking operator — carries a
 * non-blank value; picking a field alone therefore never blanks the list.
 *
 * The predicate mirrors the server's write rules exactly. A custom answer is read as
 * `find(...)?.value ?? null` because a column with NO answer is ABSENT from `custom_values`, not
 * present-with-null. A Choice answer is a single option id as a decimal string, so a match compares
 * the option ID — never a label, which would silently miss a soft-deleted option.
 *
 * Matching semantics per field type (see `clauseMatches`):
 * - `text`    `is` case-insensitive trimmed equality; `contains` case-insensitive substring.
 * - `number`  `is` numeric equality (`Number(stored) === Number(value)`).
 * - `date`    `is` exact `YYYY-MM-DD` equality.
 * - `select` / `status` / `priority`  `is` exact stored option-id string equality.
 * - `assignee` `is` means "has this member"; `is not` means "does not have this member".
 * `is empty` means missing / `null` / empty-string (for assignee: no members); `is not empty` is its
 * negation; `is not` is the negation of `is`, so an ABSENT answer counts as "is not X". `contains`
 * is offered for free-text columns only, where a substring is meaningful.
 *
 * Saved filters persist under a versioned key as JSON. Every read is wrapped and validated, so a
 * corrupt or absent value degrades to "no saved filters" rather than throwing. `search` is never
 * persisted — it is orchestration state, not a filter clause.
 */

/** The five operators a clause can carry. */
export type FilterOperator = "is" | "is_not" | "contains" | "is_empty" | "is_not_empty";

/** The operator set, in presentation order. */
export const FILTER_OPERATORS: readonly FilterOperator[] = [
    "is",
    "is_not",
    "contains",
    "is_empty",
    "is_not_empty",
];

/** The operator labels the row renders. */
export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
    is: "Is",
    is_not: "Is not",
    contains: "Contains",
    is_empty: "Is empty",
    is_not_empty: "Is not empty",
};

/** One filter row: a field, an operator and the value to match. */
export interface FilterClause {
    /** Stable, unique per row — the React key and the remove/update target, never the array index. */
    readonly id: string;
    /** `"status"`, `"priority"`, `"assignee"` or `"field:<id>"`, or `null` when no field is picked. */
    readonly fieldKey: string | null;
    readonly operator: FilterOperator;
    /** The stored string form to match; `null` / `""` means the clause is inactive. */
    readonly value: string | null;
}

/** The clause key of the built-in status column. */
export const STATUS_FIELD_KEY = "status";
/** The clause key of the built-in priority column. */
export const PRIORITY_FIELD_KEY = "priority";
/** The clause key of the built-in assignee list. */
export const ASSIGNEE_FIELD_KEY = "assignee";
/** The prefix a custom column's clause key carries before its id. */
const CUSTOM_FIELD_KEY_PREFIX = "field:";

/** The clause key of a custom column. */
export function fieldFilterKey(fieldId: number): string {
    return `${CUSTOM_FIELD_KEY_PREFIX}${fieldId}`;
}

/** The id a custom-column clause key encodes, or `null` for a built-in key or anything malformed. */
export function customFieldIdFromKey(fieldKey: string | null): number | null {
    if (fieldKey === null || !fieldKey.startsWith(CUSTOM_FIELD_KEY_PREFIX)) return null;
    const parsed = Number(fieldKey.slice(CUSTOM_FIELD_KEY_PREFIX.length));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The value-control kind a clause's field resolves to. `unknown` is a persisted field that is gone. */
export type FilterFieldKind = "status" | "priority" | "assignee" | "select" | "date" | "text" | "number" | "unknown";

/** Resolves a clause's field key to the kind that drives its operators and value control. */
export function fieldKind(fieldKey: string | null, fields: readonly TaskField[]): FilterFieldKind {
    if (fieldKey === STATUS_FIELD_KEY) return "status";
    if (fieldKey === PRIORITY_FIELD_KEY) return "priority";
    if (fieldKey === ASSIGNEE_FIELD_KEY) return "assignee";
    const fieldId = customFieldIdFromKey(fieldKey);
    if (fieldId === null) return "unknown";
    return fields.find((field) => field.id === fieldId)?.field_type ?? "unknown";
}

/**
 * The operators a field kind supports. `contains` is offered for free text alone — a substring of a
 * date or an option id is meaningless, so those kinds get the four that are well-defined.
 */
export function operatorsForKind(kind: FilterFieldKind): readonly FilterOperator[] {
    if (kind === "text") return FILTER_OPERATORS;
    return ["is", "is_not", "is_empty", "is_not_empty"];
}

/** True when an operator takes a value; `is empty` / `is not empty` take none. */
export function operatorTakesValue(operator: FilterOperator): boolean {
    return operator !== "is_empty" && operator !== "is_not_empty";
}

/** Whether an operator is one a kind supports. */
export function operatorAllowed(operator: FilterOperator, kind: FilterFieldKind): boolean {
    return operatorsForKind(kind).includes(operator);
}

let fallbackClauseSeq = 0;

/** A STABLE, unique row id — `crypto.randomUUID` where available, a counter fallback otherwise. */
export function createFilterClauseId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    fallbackClauseSeq += 1;
    return `clause-${Date.now().toString(36)}-${fallbackClauseSeq}`;
}

/** A fresh, empty clause: no field, `Is`, no value — inactive until the user fills it. */
export function createFilterClause(): FilterClause {
    return { id: createFilterClauseId(), fieldKey: null, operator: "is", value: null };
}

/** True when a clause actually filters — a field AND (for value operators) a non-blank value. */
export function isClauseActive(clause: FilterClause): boolean {
    if (clause.fieldKey === null) return false;
    if (!operatorTakesValue(clause.operator)) return true;
    return clause.value !== null && clause.value.trim() !== "";
}

/** True when any clause in the set is active — what `isFiltering` adds to the search term. */
export function anyClauseActive(clauses: readonly FilterClause[]): boolean {
    return clauses.some((clause) => isClauseActive(clause));
}

/** A non-blank stored string, else `null`; `""` and whitespace count as absent. */
function toPresentString(value: string | null): string | null {
    return value !== null && value.trim() !== "" ? value : null;
}

/** A built-in id's stored string form, or `null` when it is not a positive id. */
function builtinStored(id: number): string | null {
    return Number.isInteger(id) && id > 0 ? String(id) : null;
}

/** A custom answer, or `null` when the column has no answer (it is ABSENT from `custom_values`). */
function customStored(row: TaskTreeRow, fieldId: number): string | null {
    return row.custom_values.find((entry) => entry.field_id === fieldId)?.value ?? null;
}

/** `is` / `contains` against a scalar's stored string; `text` compares case-insensitively. */
function scalarIs(stored: string | null, value: string | null, kind: FilterFieldKind): boolean {
    const needle = value === null ? "" : value.trim();
    if (needle === "") return true;
    if (stored === null) return false;

    switch (kind) {
        case "number": {
            const target = Number(needle);
            return Number.isFinite(target) && Number(stored) === target;
        }
        case "date":
        case "select":
        case "status":
        case "priority":
            // Exact stored-string equality — for a Choice that is the option id, never a label.
            return stored === value;
        default:
            return stored.trim().toLowerCase() === needle.toLowerCase();
    }
}

/** A case-insensitive substring test; `contains` is only offered for text, this is its fallback. */
function scalarContains(stored: string | null, value: string | null): boolean {
    const needle = value === null ? "" : value.trim().toLowerCase();
    if (needle === "") return true;
    return stored !== null && stored.toLowerCase().includes(needle);
}

/** The assignee list predicate: `is` = has member, `is not` = does not have member. */
function assigneeMatches(row: TaskTreeRow, operator: FilterOperator, value: string | null): boolean {
    const hasAny = row.assignees.length > 0;
    if (operator === "is_empty") return !hasAny;
    if (operator === "is_not_empty") return hasAny;

    const needle = value === null ? "" : value.trim();
    if (needle === "") return true;
    const has = row.assignees.some((assignee) => String(assignee.user_id) === needle);
    return operator === "is_not" ? !has : has;
}

/** Does one row satisfy one clause? An inactive clause is a no-op and matches. */
export function clauseMatches(
    row: TaskTreeRow,
    clause: FilterClause,
    fields: readonly TaskField[],
): boolean {
    const { fieldKey, operator } = clause;
    if (!isClauseActive(clause) || fieldKey === null) return true;

    if (fieldKey === ASSIGNEE_FIELD_KEY) return assigneeMatches(row, operator, clause.value);

    const kind = fieldKind(fieldKey, fields);
    const stored =
        fieldKey === STATUS_FIELD_KEY
            ? builtinStored(row.status_id)
            : fieldKey === PRIORITY_FIELD_KEY
              ? builtinStored(row.priority_id)
              : customStored(row, customFieldIdFromKey(fieldKey) ?? -1);

    switch (operator) {
        case "is_empty":
            return toPresentString(stored) === null;
        case "is_not_empty":
            return toPresentString(stored) !== null;
        case "contains":
            return scalarContains(stored, clause.value);
        case "is_not":
            return !scalarIs(stored, clause.value, kind);
        case "is":
        default:
            return scalarIs(stored, clause.value, kind);
    }
}

/** Does one row satisfy every clause? Clauses combine with AND. */
export function rowMatchesClauses(
    row: TaskTreeRow,
    clauses: readonly FilterClause[],
    fields: readonly TaskField[],
): boolean {
    for (const clause of clauses) {
        if (!clauseMatches(row, clause, fields)) return false;
    }
    return true;
}

/** A saved clause set: a name plus the clauses it restores. `search` is never part of it. */
export interface SavedTaskFilter {
    readonly id: string;
    readonly name: string;
    readonly clauses: readonly FilterClause[];
}

/** The versioned localStorage key — bump the suffix if the persisted shape ever changes. */
export const SAVED_TASK_FILTERS_KEY = "pm-tasks-filters:v1";

/** A clause copy with a FRESH id, so applying a saved set creates independent rows. */
export function cloneClausesForApply(clauses: readonly FilterClause[]): FilterClause[] {
    return clauses.map((clause) => ({ ...clause, id: createFilterClauseId() }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFilterOperator(value: unknown): value is FilterOperator {
    return typeof value === "string" && (FILTER_OPERATORS as readonly string[]).includes(value);
}

/** Validates one persisted clause; a clause without a field is dropped as meaningless. */
function toClause(raw: unknown): FilterClause | null {
    if (!isRecord(raw)) return null;
    if (typeof raw.fieldKey !== "string" || raw.fieldKey === "") return null;
    if (!isFilterOperator(raw.operator)) return null;
    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : createFilterClauseId();
    return {
        id,
        fieldKey: raw.fieldKey,
        operator: raw.operator,
        value: typeof raw.value === "string" ? raw.value : null,
    };
}

/**
 * Parses the persisted JSON defensively: a non-JSON string, a non-array root and every malformed
 * entry all degrade to an empty / filtered list rather than throwing.
 */
export function parseSavedTaskFilters(raw: string | null): SavedTaskFilter[] {
    if (raw === null || raw.trim() === "") return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    const saved: SavedTaskFilter[] = [];
    for (const entry of parsed) {
        if (!isRecord(entry)) continue;
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        if (name === "" || !Array.isArray(entry.clauses)) continue;

        const clauses: FilterClause[] = [];
        for (const rawClause of entry.clauses) {
            const clause = toClause(rawClause);
            if (clause !== null) clauses.push(clause);
        }
        if (clauses.length === 0) continue;

        const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : createFilterClauseId();
        saved.push({ id, name, clauses });
    }
    return saved;
}

/** Reads the saved sets, tolerating missing storage, denied access and corrupt JSON alike. */
export function readSavedTaskFilters(): SavedTaskFilter[] {
    try {
        return parseSavedTaskFilters(window.localStorage.getItem(SAVED_TASK_FILTERS_KEY));
    } catch {
        return [];
    }
}

/** Persists the saved sets; a denied or full storage is swallowed — saving is best-effort. */
export function writeSavedTaskFilters(filters: readonly SavedTaskFilter[]): void {
    try {
        window.localStorage.setItem(SAVED_TASK_FILTERS_KEY, JSON.stringify(filters));
    } catch {
        // Storage denied or full — the in-memory list stays correct for this session.
    }
}

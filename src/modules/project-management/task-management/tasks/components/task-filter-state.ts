/**
 * The tasks page's LIVE filter (the search box plus the clause rows), persisted per browser.
 *
 * It lives in localStorage next to the column widths, under a versioned key, because it is a view
 * preference on this machine — never department data and never part of a task payload. Storing it is
 * what lets the filter survive a tab switch and a reload; without persistence, leaving Progress for
 * Calendar would drop the rows the reader had just narrowed to.
 *
 * Unlike a SAVED filter (see `task-filter.ts`), this one is saved on every keystroke and after every
 * clause edit, so the persisted value is always whatever the toolbar is showing.
 *
 * Every read is wrapped and validated: corrupt JSON, an unknown operator or a malformed clause row
 * degrades to "no filter" rather than throwing or hiding every task.
 */

import { createFilterClauseId, FILTER_OPERATORS, type FilterClause, type FilterOperator } from "./task-filter";

/** The whole live filter: what the search input holds and the clauses the builder edits. */
export interface TaskFilterState {
    readonly search: string;
    readonly clauses: readonly FilterClause[];
}

/** The unfiltered state — also the server snapshot, so hydration never disagrees with the markup. */
export const EMPTY_TASK_FILTER_STATE: TaskFilterState = { search: "", clauses: [] };

/** The versioned localStorage key — bump the suffix if the persisted shape ever changes. */
export const TASK_FILTER_STATE_KEY = "pm-tasks-filter:v1";

/** A search box is not a document; a runaway paste must not become an unbounded storage value. */
const MAX_SEARCH_LENGTH = 200;

/** A clause key is a built-in name or `field:<id>`; anything much longer is not a key we wrote. */
const MAX_FIELD_KEY_LENGTH = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFilterOperator(value: unknown): value is FilterOperator {
    return typeof value === "string" && (FILTER_OPERATORS as readonly string[]).includes(value);
}

/**
 * One persisted clause, or `null` when it cannot be trusted.
 *
 * Ids are React keys and edit targets, so a duplicate or missing id is replaced rather than kept —
 * two rows sharing a key would make removing one remove the wrong one.
 */
function parseClause(value: unknown, seenIds: Set<string>): FilterClause | null {
    if (!isRecord(value)) return null;

    const fieldKey = value.fieldKey;
    if (fieldKey !== null) {
        if (typeof fieldKey !== "string" || fieldKey.trim() === "" || fieldKey.length > MAX_FIELD_KEY_LENGTH) {
            return null;
        }
    }

    if (!isFilterOperator(value.operator)) return null;

    const rawValue = value.value;
    if (rawValue !== null && typeof rawValue !== "string") return null;

    const storedId = typeof value.id === "string" && value.id !== "" && !seenIds.has(value.id) ? value.id : null;
    const id = storedId ?? createFilterClauseId();
    seenIds.add(id);

    return {
        id,
        fieldKey: fieldKey as string | null,
        operator: value.operator,
        value: rawValue,
    };
}

/** Parses the persisted JSON defensively; a malformed root or entry is dropped, never thrown. */
export function parseTaskFilterState(raw: string | null): TaskFilterState {
    if (raw === null || raw.trim() === "") return EMPTY_TASK_FILTER_STATE;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return EMPTY_TASK_FILTER_STATE;
    }
    if (!isRecord(parsed)) return EMPTY_TASK_FILTER_STATE;

    const search = typeof parsed.search === "string" ? parsed.search.slice(0, MAX_SEARCH_LENGTH) : "";

    const seenIds = new Set<string>();
    const clauses: FilterClause[] = [];
    if (Array.isArray(parsed.clauses)) {
        for (const entry of parsed.clauses) {
            const clause = parseClause(entry, seenIds);
            if (clause !== null) clauses.push(clause);
        }
    }

    return { search, clauses };
}

/** Reads the stored filter, tolerating missing storage, denied access and corrupt JSON alike. */
export function readTaskFilterState(): TaskFilterState {
    try {
        return parseTaskFilterState(window.localStorage.getItem(TASK_FILTER_STATE_KEY));
    } catch {
        return EMPTY_TASK_FILTER_STATE;
    }
}

/** Persists the filter; a denied or full storage is swallowed — remembering is best-effort. */
export function writeTaskFilterState(state: TaskFilterState): void {
    try {
        window.localStorage.setItem(TASK_FILTER_STATE_KEY, JSON.stringify(state));
    } catch {
        // Storage denied or full — the in-memory filter stays correct for this session.
    }
}

/**
 * The clauses that still name something this department has.
 *
 * A persisted `field:<id>` clause outlives the column it was written for: rename or delete that
 * custom field and the clause would match no row at all, which reads as "the list is empty" rather
 * than "one filter is stale". Built-in keys are always known; only a custom key can go missing.
 */
export function knownClauses(
    clauses: readonly FilterClause[],
    fieldIds: ReadonlySet<number>,
): readonly FilterClause[] {
    return clauses.filter((clause) => {
        if (clause.fieldKey === null || !clause.fieldKey.startsWith("field:")) return true;
        const fieldId = Number(clause.fieldKey.slice("field:".length));
        return Number.isInteger(fieldId) && fieldIds.has(fieldId);
    });
}

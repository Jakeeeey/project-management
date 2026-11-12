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

import {
    createFilterClauseId,
    createFilterGroupId,
    FILTER_OPERATORS,
    type FilterClause,
    type FilterGroup,
    type FilterGroupOperator,
    type FilterOperator,
} from "./task-filter";

/** The whole live filter: what the search input holds and the clause groups the builder edits. */
export interface TaskFilterState {
    readonly search: string;
    readonly groups: readonly FilterGroup[];
}

/** The unfiltered state — also the server snapshot, so hydration never disagrees with the markup. */
export const EMPTY_TASK_FILTER_STATE: TaskFilterState = { search: "", groups: [] };

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

/**
 * Parses the persisted JSON defensively; a malformed root or entry is dropped, never thrown.
 *
 * A value written before groups existed holds a flat `clauses` array. It is read back as one AND
 * group, which is what those clauses meant, so an upgrade never loses the reader's filter.
 */
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

    const groups: FilterGroup[] = [];
    if (Array.isArray(parsed.groups)) {
        for (const entry of parsed.groups) {
            if (!isRecord(entry)) continue;
            const clauses = parseClauses(entry.clauses, seenIds);
            if (clauses.length === 0) continue;
            const operator: FilterGroupOperator = entry.operator === "or" ? "or" : "and";
            const storedGroupId =
                typeof entry.id === "string" && entry.id !== "" && !seenIds.has(entry.id) ? entry.id : null;
            const id = storedGroupId ?? createFilterGroupId();
            seenIds.add(id);
            groups.push({ id, operator, clauses });
        }
    } else if (Array.isArray(parsed.clauses)) {
        const clauses = parseClauses(parsed.clauses, seenIds);
        if (clauses.length > 0) groups.push({ id: createFilterGroupId(), operator: "and", clauses });
    }

    return { search, groups };
}

/** The valid clauses of one persisted group. */
function parseClauses(raw: unknown, seenIds: Set<string>): FilterClause[] {
    if (!Array.isArray(raw)) return [];
    const clauses: FilterClause[] = [];
    for (const entry of raw) {
        const clause = parseClause(entry, seenIds);
        if (clause !== null) clauses.push(clause);
    }
    return clauses;
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
 * The groups whose clauses still name something this department has.
 *
 * A persisted `field:<id>` clause outlives the column it was written for: rename or delete that
 * custom field and the clause would match no row at all, which reads as "the list is empty" rather
 * than "one filter is stale". Built-in keys are always known; only a custom key can go missing. A
 * group left with no clauses at all is dropped instead of being kept as a match-everything block.
 */
export function knownGroups(
    groups: readonly FilterGroup[],
    fieldIds: ReadonlySet<number>,
): readonly FilterGroup[] {
    const known: FilterGroup[] = [];
    for (const group of groups) {
        const clauses = group.clauses.filter((clause) => isKnownClauseKey(clause.fieldKey, fieldIds));
        if (clauses.length > 0) known.push({ ...group, clauses });
    }
    return known;
}

/** The flat form of {@link knownGroups}, for callers still holding a clause array. */
export function knownClauses(
    clauses: readonly FilterClause[],
    fieldIds: ReadonlySet<number>,
): readonly FilterClause[] {
    return clauses.filter((clause) => isKnownClauseKey(clause.fieldKey, fieldIds));
}

/** A built-in key is always known; a custom key survives only while its column does. */
function isKnownClauseKey(fieldKey: string | null, fieldIds: ReadonlySet<number>): boolean {
    if (fieldKey === null || !fieldKey.startsWith("field:")) return true;
    const fieldId = Number(fieldKey.slice("field:".length));
    return Number.isInteger(fieldId) && fieldIds.has(fieldId);
}

/**
 * The task tree's per-column widths: the defaults, the floors, and the per-user store of overrides.
 *
 * Widths are a PRESENTATION concern and are per-USER, per-BROWSER — never department data, never a
 * column on a task/department payload. They persist under a versioned localStorage key exactly the
 * way the saved filters do (see `task-filter.ts`): every read is wrapped and validated, so a corrupt
 * or absent value degrades to the default layout rather than throwing or producing a bad width.
 *
 * The keys mirror the table's column keys in `TaskTree.tsx` verbatim. Custom columns are unbounded
 * (`field-<id>` per department field), so they are NOT members of the closed `TaskColumnKey` union:
 * the union carries the fixed columns plus the `field` FAMILY default every custom column inherits,
 * while an individually resized custom column is persisted under its own dynamic `field-<id>` key.
 * That is why `DEFAULT_TASK_COLUMN_WIDTHS` can stay a finite `Record<TaskColumnKey, number>` — a
 * template-literal key (`field-${number}`) has no finite record to enumerate.
 *
 * Runtime numbers are applied as INLINE STYLES, never Tailwind classes: an arbitrary width can never
 * become a class literal (the same rule the catalog colours follow in `CatalogChip.tsx`).
 */

/** The fixed table columns, plus the `field` family default every custom column starts from. */
export type TaskColumnKey =
    | "expand"
    | "title"
    | "assignees"
    | "start"
    | "due"
    | "priority"
    | "status"
    | "actions"
    | "field";

/**
 * The default widths, seeded from the classes the table hardcoded before widths became dynamic, so
 * the initial layout is IDENTICAL to the pre-resize table: `expand 76`, `title 220`, `assignees 160`,
 * `start 160`, `due 160`, `priority 140`, `status 140`, `actions 72`. Custom columns start at 160 —
 * the `field` entry below, which is also what an override-less custom column resolves to.
 */
export const DEFAULT_TASK_COLUMN_WIDTHS: Record<TaskColumnKey, number> = {
    expand: 76,
    title: 220,
    assignees: 160,
    start: 160,
    due: 160,
    priority: 140,
    status: 140,
    actions: 72,
    field: 160,
};

/**
 * The floor per column: nothing can be dragged narrower than this. The narrow utility gutters
 * (expand, actions) get a smaller floor than the text columns, because they hold one control each;
 * the text columns still keep enough room that their truncation is legible rather than a single
 * glyph. Custom columns share the `field` floor. (A fixed column's floor is moot — see
 * `NON_RESIZABLE_TASK_COLUMN_KEYS` — but it stays here so the record remains total over the union.)
 */
export const MIN_TASK_COLUMN_WIDTHS: Record<TaskColumnKey, number> = {
    expand: 68,
    title: 160,
    assignees: 120,
    start: 120,
    due: 120,
    priority: 110,
    status: 110,
    actions: 56,
    field: 120,
};

/**
 * The structural gutters whose width is NOT a user preference: the `expand` control gutter (drag
 * handle + accordion chevron) and the `actions` icon gutter. Their widths are pinned by the table's
 * own geometry — `expand` is the leading frozen column, so its 76px is the baseline every following
 * column's frozen offset is derived from — and nothing in the row reads a "wider gutter" as a
 * preference. Letting them be dragged would silently shift the frozen block and the indentation
 * baseline for no benefit, so they are fixed.
 *
 * This constant is the SINGLE SOURCE OF TRUTH for "which columns may be resized": the header reads
 * `isResizableTaskColumnKey` to decide whether to render a handle, and the width store reads
 * `isNonResizableTaskColumnKey` to ignore any persisted or proposed override for these keys. Every
 * other column — the data columns and every custom `field-*` column — stays resizable.
 */
export const NON_RESIZABLE_TASK_COLUMN_KEYS = ["expand", "actions"] as const;
export type NonResizableTaskColumnKey = (typeof NON_RESIZABLE_TASK_COLUMN_KEYS)[number];

/** True for a structural gutter whose width must never change by any path. */
export function isNonResizableTaskColumnKey(columnKey: string): columnKey is NonResizableTaskColumnKey {
    return (NON_RESIZABLE_TASK_COLUMN_KEYS as readonly string[]).includes(columnKey);
}

/** True when a column may be resized: every data column, never a structural gutter. */
export function isResizableTaskColumnKey(columnKey: string): boolean {
    return !isNonResizableTaskColumnKey(columnKey);
}

/** The per-column overrides a user has dragged: the fixed keys plus any `field-<id>` entries. */
export type TaskColumnWidthOverrides = Partial<Record<TaskColumnKey, number>> &
    Readonly<Record<string, number>>;

/** The prefix a custom column's dynamic override key carries before its field id. */
const CUSTOM_COLUMN_KEY_PREFIX = "field-";

/** True for a fixed-column key (including the `field` family default). */
function isFixedTaskColumnKey(value: string): value is TaskColumnKey {
    return Object.prototype.hasOwnProperty.call(DEFAULT_TASK_COLUMN_WIDTHS, value);
}

/** The field id a `field-<id>` override key encodes, or `null` for anything else. */
export function customFieldIdFromColumnKey(columnKey: string): number | null {
    if (!columnKey.startsWith(CUSTOM_COLUMN_KEY_PREFIX)) return null;
    const parsed = Number(columnKey.slice(CUSTOM_COLUMN_KEY_PREFIX.length));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** True when a persisted key names a column this store knows — a fixed key or a `field-<id>` key. */
function isPersistableColumnKey(value: string): boolean {
    return isFixedTaskColumnKey(value) || customFieldIdFromColumnKey(value) !== null;
}

/** The default width of any column key: the fixed value, else the custom family's 160. */
export function defaultTaskColumnWidth(columnKey: string): number {
    return isFixedTaskColumnKey(columnKey)
        ? DEFAULT_TASK_COLUMN_WIDTHS[columnKey]
        : DEFAULT_TASK_COLUMN_WIDTHS.field;
}

/** The floor of any column key: the fixed floor, else the custom family's floor. */
export function minTaskColumnWidth(columnKey: string): number {
    return isFixedTaskColumnKey(columnKey) ? MIN_TASK_COLUMN_WIDTHS[columnKey] : MIN_TASK_COLUMN_WIDTHS.field;
}

/**
 * A proposed width brought inside the column's floor and rounded to a whole pixel. A non-finite
 * proposal (a `NaN` from a bad pointer delta, say) falls back to the column's default rather than
 * poisoning the layout.
 */
export function clampTaskColumnWidth(columnKey: string, width: number): number {
    // A structural gutter has no adjustable width, so no proposal may move it. This is the store
    // half of the invariant: the header renders no handle for these keys, and this guarantees a
    // direct/programmatic `setColumnWidth` cannot resize them either.
    if (isNonResizableTaskColumnKey(columnKey)) return defaultTaskColumnWidth(columnKey);
    if (!Number.isFinite(width)) return defaultTaskColumnWidth(columnKey);
    return Math.max(minTaskColumnWidth(columnKey), Math.round(width));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses the persisted JSON defensively: a non-JSON string, a non-object root, an unknown key, a
 * non-number or non-finite value are all DROPPED (never thrown), and a finite value below its floor
 * is clamped up. A malformed entry therefore degrades to the default layout, never to a broken one.
 */
export function parseTaskColumnWidths(raw: string | null): TaskColumnWidthOverrides {
    if (raw === null || raw.trim() === "") return {};

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!isRecord(parsed)) return {};

    const overrides: Record<string, number> = {};
    for (const [columnKey, value] of Object.entries(parsed)) {
        if (!isPersistableColumnKey(columnKey)) continue;
        // A structural gutter's width is not a preference, so a `expand`/`actions` override persisted
        // by the build that still allowed it is DROPPED here — silently inert, without a key bump and
        // without discarding the user's other widths. The stale on-disk entry is purged the next time
        // any column is resized (the write spreads this parsed snapshot, which no longer carries it).
        if (isNonResizableTaskColumnKey(columnKey)) continue;
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        overrides[columnKey] = clampTaskColumnWidth(columnKey, value);
    }
    return overrides;
}

/** The versioned localStorage key — bump the suffix if the persisted shape ever changes. */
export const TASK_COLUMN_WIDTHS_KEY = "pm-tasks-column-widths:v1";

/** Reads the overrides, tolerating missing storage, denied access and corrupt JSON alike. */
export function readTaskColumnWidths(): TaskColumnWidthOverrides {
    try {
        return parseTaskColumnWidths(window.localStorage.getItem(TASK_COLUMN_WIDTHS_KEY));
    } catch {
        return {};
    }
}

/** Persists the overrides; a denied or full storage is swallowed — saving is best-effort. */
export function writeTaskColumnWidths(overrides: TaskColumnWidthOverrides): void {
    try {
        window.localStorage.setItem(TASK_COLUMN_WIDTHS_KEY, JSON.stringify(overrides));
    } catch {
        // Storage denied or full — the in-memory widths stay correct for this session.
    }
}

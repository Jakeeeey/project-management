/**
 * The tag rules that need no I/O: the tolerated `is_deleted` shapes, live-row filtering, ordering,
 * the duplicate-label verdict, the revive candidate and the per-task grouping.
 *
 * Zero imports on purpose: `__assert.ts` loads this file directly under plain Node, which resolves
 * neither the module's `@/…` aliases nor an extensionless specifier (see that file's header).
 */

/** The tag columns every rule below reads; `is_deleted` stays `unknown` because Directus varies its shape. */
export interface TagRow {
    readonly id: number;
    readonly label: string;
    readonly sort_order: number;
    readonly is_deleted: unknown;
}

/** One `pm_task_tag` row, reduced to what grouping needs. */
export interface TaskTagLinkRow {
    readonly task_id: unknown;
    readonly tag_id: unknown;
    readonly is_deleted: unknown;
}

/** A live tag attached to a task. */
export interface TaskTagRef {
    readonly tag_id: number;
}

/**
 * A soft-delete flag in every shape this API receives: `0`/`1` as a number or string, a boolean, or
 * the JSON-decoded Buffer object (`{ "type": "Buffer", "data": [1] }` — conventions.md section 6).
 */
export function isTagDeleted(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
    if (typeof value !== "object" || value === null) return false;
    const data = (value as { readonly data?: unknown }).data;
    return Array.isArray(data) && data.some((byte) => byte === 1 || byte === 0x31);
}

export function liveTagRows<T extends TagRow>(rows: readonly T[]): T[] {
    return rows.filter((row) => !isTagDeleted(row.is_deleted));
}

/** `(sort_order, id)` — the order every tag picker and the configuration list render. */
export function sortTagRows<T extends TagRow>(rows: readonly T[]): T[] {
    return [...rows].sort((left, right) => left.sort_order - right.sort_order || left.id - right.id);
}

/** The comparison the duplicate check and the revive lookup share: trim + case-fold. */
export function normaliseTagLabel(label: string): string {
    return label.trim().toLowerCase();
}

/**
 * The live row that already carries this label, if any — the 400 a create or a rename answers with.
 * `pm_tag` has no unique key of its own (the DDL pins `(department_id, label)` as a logical key
 * only), so this check is read-then-write; the lowest id wins so the answer is stable.
 */
export function duplicateTagRow<T extends TagRow>(rows: readonly T[], label: string, excludeId?: number): T | null {
    const wanted = normaliseTagLabel(label);
    let match: T | null = null;
    for (const row of liveTagRows(rows)) {
        if (row.id === excludeId) continue;
        if (normaliseTagLabel(row.label) !== wanted) continue;
        if (match === null || row.id < match.id) match = row;
    }
    return match;
}

/**
 * The row a create should REVIVE instead of inserting — the logical key `(department_id, label)`
 * ignores `is_deleted`, so a blind INSERT after a delete would duplicate it. A live match comes back
 * too; the caller reads `isTagDeleted` to choose between reviving and refusing.
 */
export function tagReviveCandidate<T extends TagRow>(rows: readonly T[], label: string): T | null {
    const wanted = normaliseTagLabel(label);
    let match: T | null = null;
    for (const row of rows) {
        if (normaliseTagLabel(row.label) !== wanted) continue;
        if (match === null || row.id < match.id) match = row;
    }
    return match;
}

/** The live links grouped by task; a row without a usable task id or tag id is attached to nothing. */
export function tagRefsByTask(rows: readonly TaskTagLinkRow[]): Map<number, TaskTagRef[]> {
    const grouped = new Map<number, TaskTagRef[]>();
    for (const row of rows) {
        if (isTagDeleted(row.is_deleted)) continue;
        const taskId = toPositiveId(row.task_id);
        const tagId = toPositiveId(row.tag_id);
        if (taskId === null || tagId === null) continue;
        const bucket = grouped.get(taskId);
        if (bucket === undefined) grouped.set(taskId, [{ tag_id: tagId }]);
        else if (!bucket.some((ref) => ref.tag_id === tagId)) bucket.push({ tag_id: tagId });
    }
    return grouped;
}

/** One task's nested-alias slot, tolerated as any array of row objects. */
export function tagLinksOf(value: unknown): readonly TaskTagLinkRow[] {
    if (!Array.isArray(value)) return [];
    return value.filter((row): row is TaskTagLinkRow => typeof row === "object" && row !== null);
}

function toPositiveId(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The department-scoping loaders — the one implementation of the module's most important rule.
 *
 * Every handler that names a row (read OR write) first loads that row here. Each loader applies
 * `filter[department_id][_eq]=<actorDepartmentId>&filter[is_deleted][_eq]=0` (encoded as the JSON
 * filter Directus expects) and returns `null` when nothing matches. A route turns `null` into a
 * 404 — never a 403 — so the existence of another department's row is never confirmed.
 *
 * The loaders return `null` rather than throwing so the check can run first, before any capability
 * check, any parent/user validation and any write, without every route needing a try/catch.
 * `assertSameDepartment` covers rows that arrived by another path (a `parent_id` target).
 *
 * `isSameDepartment`, `assertSameDepartment` and `DepartmentScopeError` live in
 * `./department-scope` — a zero-import file so the pure predicate stays assertable in Phase A —
 * and are re-exported here so `scoping.ts` presents the full invariant surface.
 */

import { readItems } from "./directus-client";
import type { ScopedActor } from "./actor-service";

export { DepartmentScopeError, assertSameDepartment, isSameDepartment } from "./department-scope";

/**
 * Which catalog table a configuration row belongs to. Mandatory on every catalog call because the
 * two tables have independent auto-increment id spaces, so a bare id is ambiguous.
 */
export type ConfigKind = "status" | "priority";

const CONFIG_COLLECTIONS: Record<ConfigKind, string> = {
    status: "pm_task_status",
    priority: "pm_task_priority",
};

/**
 * A live `pm_task` row as the scoped loader returns it. Extra fields (relation aliases, resolved
 * catalogs) can ride along at runtime; this names what the module is guaranteed to read.
 */
export interface ScopedTaskRow {
    readonly id: number;
    readonly department_id: number;
    readonly parent_id: number | null;
    readonly status_id: number;
    readonly priority_id: number;
    readonly title: string;
    readonly description: string | null;
    readonly start_date: string | null;
    readonly end_date: string | null;
    readonly sort_order: number;
    readonly is_deleted: number;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
}

/** A live `pm_task_attachment` row as the scoped loader returns it. */
export interface ScopedAttachmentRow {
    readonly id: number;
    readonly task_id: number;
    readonly department_id: number;
    readonly file_id: string;
    readonly file_name: string | null;
    readonly file_type: string | null;
    readonly file_size: number | null;
    readonly sort_order: number;
    readonly is_deleted: number;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
}

/** A live `pm_task_status` or `pm_task_priority` row as the scoped loader returns it. */
export interface ScopedConfigRow {
    readonly id: number;
    readonly department_id: number;
    readonly label: string;
    readonly color: string | null;
    readonly sort_order: number;
    readonly is_default: number;
    readonly is_deleted: number;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
}

/**
 * Normalises a route-supplied id. A value that cannot be a primary key resolves to "no match"
 * (404) rather than a query, so a malformed id never reaches Directus and never confirms anything.
 */
function toScopedId(value: string | number): number | null {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Loads a live task only when it belongs to the actor's department.
 *
 * @returns The row, or `null` — which every caller maps to 404 (task absent, soft-deleted, or
 *          another department's; the three are deliberately indistinguishable).
 */
export async function loadTaskScoped(actor: ScopedActor, taskId: string | number): Promise<ScopedTaskRow | null> {
    const id = toScopedId(taskId);
    if (id === null) return null;

    const rows = await readItems<ScopedTaskRow>("pm_task", {
        filter: {
            id: { _eq: id },
            department_id: { _eq: actor.departmentId },
            is_deleted: { _eq: 0 },
        },
        limit: 1,
    });
    return rows[0] ?? null;
}

/**
 * Loads a live attachment only when it belongs to the actor's department. Used by the stream route
 * before a single byte is fetched, and by detach before the soft-delete.
 */
export async function loadAttachmentScoped(
    actor: ScopedActor,
    attachmentId: string | number,
): Promise<ScopedAttachmentRow | null> {
    const id = toScopedId(attachmentId);
    if (id === null) return null;

    const rows = await readItems<ScopedAttachmentRow>("pm_task_attachment", {
        filter: {
            id: { _eq: id },
            department_id: { _eq: actor.departmentId },
            is_deleted: { _eq: 0 },
        },
        limit: 1,
    });
    return rows[0] ?? null;
}

/**
 * Loads a live status or priority catalog row from the actor's department.
 *
 * `kind` selects the table — the two catalogs have independent id spaces, so the same numeric id
 * names two different rows. It is mandatory, not defaulted.
 */
export async function loadConfigScoped(
    actor: ScopedActor,
    kind: ConfigKind,
    id: string | number,
): Promise<ScopedConfigRow | null> {
    const rowId = toScopedId(id);
    if (rowId === null) return null;

    const rows = await readItems<ScopedConfigRow>(CONFIG_COLLECTIONS[kind], {
        filter: {
            id: { _eq: rowId },
            department_id: { _eq: actor.departmentId },
            is_deleted: { _eq: 0 },
        },
        limit: 1,
    });
    return rows[0] ?? null;
}

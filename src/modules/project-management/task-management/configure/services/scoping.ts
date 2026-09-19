/**
 * The department-scoping loaders — the one implementation of the module's most important rule.
 *
 * Every handler that names a row (read OR write) first loads that row here. Each loader applies
 * `filter[department_id][_eq]=<actorDepartmentId>&filter[is_deleted][_eq]=0` (encoded as the JSON
 * filter Directus expects) and returns `null` when nothing matches. A route turns `null` into a
 * 404 — never a 403 — so the existence of another department's row is never confirmed.
 *
 * `list_id` adds a second dimension to the TASK-facing loaders. It is a VIEW dimension, not a
 * security boundary: an actor may view every list of their own department, so the by-id task load
 * (`loadTaskScoped`) keeps department scoping and takes the list as an OPTIONAL narrowing for
 * callers that already hold one, while a read OF A LIST (`loadListScoped`, and the collection read
 * in `task-service`) scopes by department AND list. `loadAttachmentScoped` stays department-scoped:
 * an attachment is reached through its task, and a list adds no boundary that department scoping
 * does not already provide. The catalog loaders below stay department-scoped too: statuses,
 * priorities, custom columns and their options are shared per department and never gain a list
 * dimension.
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
    /**
     * `pm_task_list.id` — REQUIRED on a task. A subtask's list always equals its parent's list, so
     * the column is what binds a subtree to one list; `PATCH` can never change it and a cross-list
     * re-parent is refused rather than moved.
     */
    readonly list_id: number;
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

/** A live `pm_task_list` row as the scoped loader returns it — one department's task list. */
export interface ScopedListRow {
    readonly id: number;
    readonly department_id: number;
    readonly name: string;
    readonly sort_order: number;
    readonly is_default: number;
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
    /**
     * `VARCHAR(64)` lucide icon name or absent; optional and `unknown` for the same pre-DDL reason
     * as `ScopedFieldRow.is_enabled`. Every reader normalises it through `normalizeIconName`, so a
     * missing column and a stale value both resolve to the same "no icon" answer.
     */
    readonly icon?: unknown;
}

/** A live `pm_task_field` row as the scoped loader returns it — one custom task column. */
export interface ScopedFieldRow {
    readonly id: number;
    readonly department_id: number;
    readonly label: string;
    readonly field_type: string;
    readonly sort_order: number;
    readonly is_deleted: number;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
    /**
     * `TINYINT(1) NOT NULL DEFAULT 1`, and `default_value` a nullable TEXT.
     *
     * Both are `unknown` and OPTIONAL on purpose: the columns arrive in a change of their own, so a
     * deployment can be running this code before the `ALTER TABLE`. A missing column is therefore a
     * real shape to handle, and `unknown` forces every reader through the same normalisation instead
     * of trusting a type the database may not yet satisfy.
     */
    readonly is_enabled?: unknown;
    readonly default_value?: unknown;
}

/** A live `pm_task_field_option` row as the scoped loader returns it — one choice of a select column. */
export interface ScopedFieldOptionRow {
    readonly id: number;
    readonly field_id: number;
    readonly department_id: number;
    readonly label: string;
    readonly sort_order: number;
    readonly is_deleted: number;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
    /** `VARCHAR(32)` hex or absent; optional for the same pre-DDL reason as `ScopedFieldRow.is_enabled`. */
    readonly color?: unknown;
    /** `VARCHAR(64)` lucide icon name or absent; optional for the same pre-DDL reason as `color`. */
    readonly icon?: unknown;
}

/** A live `pm_task_field_value` row as the scoped loader returns it — one task's answer. */
export interface ScopedFieldValueRow {
    readonly id: number;
    readonly task_id: number;
    readonly field_id: number;
    readonly department_id: number;
    readonly value: string | null;
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
 * Loads a live task that belongs to the actor's department, optionally narrowed to one task list.
 *
 * `listId` is OPTIONAL by design. List is a view dimension, not a security boundary — an actor may
 * view every list of their own department — and a by-id load usually happens before any list is
 * known (the `/tasks/<id>` routes), so requiring a list here would invent a boundary the module
 * does not have. A caller that already holds a list (the read-backs after an update or a move)
 * passes it, and the extra `filter[list_id]` then asserts the row is still reachable through that
 * exact scope. An id that cannot name a list is "no match", never a query.
 *
 * @returns The row, or `null` — which every caller maps to 404 (task absent, soft-deleted, in
 *          another department, or outside the requested list; the cases are deliberately
 *          indistinguishable).
 */
export async function loadTaskScoped(
    actor: ScopedActor,
    taskId: string | number,
    listId?: string | number | null,
): Promise<ScopedTaskRow | null> {
    const id = toScopedId(taskId);
    if (id === null) return null;

    const narrowedListId = listId === undefined || listId === null ? null : toScopedId(listId);
    if (listId !== undefined && listId !== null && narrowedListId === null) return null;

    const filter: Record<string, unknown> = {
        id: { _eq: id },
        department_id: { _eq: actor.departmentId },
        is_deleted: { _eq: 0 },
    };
    if (narrowedListId !== null) filter.list_id = { _eq: narrowedListId };

    const rows = await readItems<ScopedTaskRow>("pm_task", { filter, limit: 1 });
    return rows[0] ?? null;
}

/**
 * Loads a live task list only when it belongs to the actor's department — a read OF A LIST, so the
 * scope is department AND list, unlike the by-id task load above.
 *
 * @returns The row, or `null` (absent, soft-deleted, or another department's — indistinguishable),
 *          which every caller maps to 404.
 */
export async function loadListScoped(actor: ScopedActor, listId: string | number): Promise<ScopedListRow | null> {
    const id = toScopedId(listId);
    if (id === null) return null;

    const rows = await readItems<ScopedListRow>("pm_task_list", {
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

/**
 * Loads a live custom task column from the actor's department. Used before any field write and by
 * the value writer, so a value can never be attached to another department's column.
 */
export async function loadFieldScoped(actor: ScopedActor, fieldId: string | number): Promise<ScopedFieldRow | null> {
    const id = toScopedId(fieldId);
    if (id === null) return null;

    const rows = await readItems<ScopedFieldRow>("pm_task_field", {
        filter: {
            id: { _eq: id },
            department_id: { _eq: actor.departmentId },
            is_deleted: { _eq: 0 },
        },
        limit: 1,
    });
    return rows[0] ?? null;
}

/** Loads a live choice of the actor's department. The option's own `field_id` is what binds it to a column. */
export async function loadFieldOptionScoped(
    actor: ScopedActor,
    optionId: string | number,
): Promise<ScopedFieldOptionRow | null> {
    const id = toScopedId(optionId);
    if (id === null) return null;

    const rows = await readItems<ScopedFieldOptionRow>("pm_task_field_option", {
        filter: {
            id: { _eq: id },
            department_id: { _eq: actor.departmentId },
            is_deleted: { _eq: 0 },
        },
        limit: 1,
    });
    return rows[0] ?? null;
}

import { isTrueFlag } from "@/modules/project-management/task-management/configure/services/task-config-policy";
import type {
    ScopedAttachmentRow,
    ScopedConfigRow,
    ScopedFieldValueRow,
} from "./scoping";
import type { PermissionContext } from "./permission-service";
import type { CatalogLists } from "@/modules/project-management/task-management/configure/services/task-config-service";
import type { TaskFieldClientRow, TaskFieldValueClientRow } from "./task-field-service";
import { normalizeIconName } from "../components/catalog-icon";

/**
 * The projection layer between Directus rows and the tasks route's wire payload.
 *
 * It exists because the `pm_task` read has two shapes — the nested-alias form and the scoped
 * per-collection fallback — and the client must not be able to tell which one served it. Every
 * normalization lives here: the tolerated `is_deleted` shapes (conventions.md section 6), the
 * number coercion, the nested-row grouping, and the per-row catalog resolution and `can_delete`.
 */

/** A live `pm_task_assignee` row as the list payload carries it. */
export interface TaskAssigneeRow {
    readonly id: number;
    readonly task_id: number;
    readonly user_id: number;
    readonly department_id: number;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
    readonly is_deleted?: unknown;
}

/**
 * A task row as the API hands it to the UI: the stored columns, the live nested rows, the
 * server-computed delete answer, and the status/priority labels resolved from live catalog rows
 * only (an id that no longer resolves becomes `null`, never a stale label).
 */
export interface TaskClientRow {
    readonly id: number;
    readonly department_id: number;
    readonly parent_id: number | null;
    /** The task's list — a view dimension the client will switch on; every task carries one. */
    readonly list_id: number;
    readonly status_id: number;
    readonly priority_id: number;
    readonly title: string;
    readonly description: string | null;
    readonly start_date: string | null;
    readonly end_date: string | null;
    readonly sort_order: number;
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
    readonly assignees: readonly TaskAssigneeRow[];
    readonly attachments: readonly ScopedAttachmentRow[];
    readonly custom_values: readonly TaskFieldValueClientRow[];
    /** The server's per-row edit answer: head, granted access, or this task's creator. */
    readonly can_edit: boolean;
    /** The server's per-row delete answer: head, granted access, or this task's creator. */
    readonly can_delete: boolean;
    readonly status_label: string | null;
    readonly status_color: string | null;
    /** The live status row's icon, normalised through `normalizeIconName` — allow-listed or `null`. */
    readonly status_icon: string | null;
    readonly priority_label: string | null;
    readonly priority_color: string | null;
    /** The live priority row's icon, normalised through `normalizeIconName` — allow-listed or `null`. */
    readonly priority_icon: string | null;
}

/** The GET payload: the department's flat rows, the catalogs their labels resolve from, and the custom columns the rows carry answers for. */
export interface DepartmentTaskList {
    readonly rows: readonly TaskClientRow[];
    readonly catalogs: CatalogLists;
    readonly fields: readonly TaskFieldClientRow[];
}

/**
 * A `pm_task` row as Directus returns it. Every column is optional-unknown on purpose: relation
 * aliases ride along under their own keys, and a `TINYINT`/id can arrive in more than one shape.
 */
export interface RawTaskRow {
    readonly id: number;
    readonly department_id?: unknown;
    readonly parent_id?: unknown;
    readonly list_id?: unknown;
    readonly status_id?: unknown;
    readonly priority_id?: unknown;
    readonly title?: unknown;
    readonly description?: unknown;
    readonly start_date?: unknown;
    readonly end_date?: unknown;
    readonly sort_order?: unknown;
    readonly created_at?: unknown;
    readonly created_by?: unknown;
    readonly updated_at?: unknown;
    readonly updated_by?: unknown;
    readonly [alias: string]: unknown;
}

/** A task row plus the live nested rows the shaping step attaches to it. */
export interface TaskRowSource {
    readonly row: RawTaskRow;
    readonly assignees: readonly TaskAssigneeRow[];
    readonly attachments: readonly ScopedAttachmentRow[];
    readonly values: readonly ScopedFieldValueRow[];
}

/** Everything the row shaper needs that is shared by every row of one response. */
export interface RowShaping {
    readonly statuses: ReadonlyMap<number, ScopedConfigRow>;
    readonly priorities: ReadonlyMap<number, ScopedConfigRow>;
    readonly permissions: PermissionContext;
}

/** `Number(null)` is `0`, so nullish is checked before conversion. */
function toNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads a `TINYINT(1)` flag that may arrive as a number, a string, a boolean or a Buffer.
 *
 * `isTrueFlag` covers the scalar shapes and a real `Uint8Array`, but the shape this API actually
 * receives over the wire is the JSON-decoded Buffer **object** (`{ "type": "Buffer", "data": [1] }`
 * — conventions.md section 6), which no `instanceof` check catches. Both Buffer shapes are read
 * here, so a soft-deleted row can never survive a strip.
 */
export function isDeletedFlag(value: unknown): boolean {
    if (isTrueFlag(value)) return true;
    if (typeof value !== "object" || value === null) return false;
    const data = (value as { readonly data?: unknown }).data;
    return Array.isArray(data) && data.some((byte) => byte === 1 || byte === 0x31);
}

/** The live rows of a nested set, tolerating every `is_deleted` shape Directus can return. */
export function liveNestedRows<T>(value: unknown): T[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (candidate): candidate is T =>
            typeof candidate === "object" &&
            candidate !== null &&
            !isDeletedFlag((candidate as { is_deleted?: unknown }).is_deleted),
    );
}

/** Groups nested rows by `task_id`; a row without a resolvable task id is not attached to anything. */
export function groupByTaskId<T extends { readonly task_id: unknown }>(rows: readonly T[]): Map<number, T[]> {
    const grouped = new Map<number, T[]>();
    for (const row of rows) {
        const taskId = toNumberOrNull(row.task_id);
        if (taskId === null) continue;
        const bucket = grouped.get(taskId);
        if (bucket === undefined) grouped.set(taskId, [row]);
        else bucket.push(row);
    }
    return grouped;
}

/** Resolves the shared per-response shaping: both catalog indexes plus the permission context. */
export function buildShaping(catalogs: CatalogLists, permissions: PermissionContext): RowShaping {
    return {
        statuses: new Map(catalogs.statuses.map((row) => [row.id, row])),
        priorities: new Map(catalogs.priorities.map((row) => [row.id, row])),
        permissions,
    };
}

/**
 * Drops answers whose column is no longer live.
 *
 * Removing a column deliberately keeps every stored answer, so that adding the column back restores
 * them. That makes an orphaned answer possible, and it must not ride the payload: the client renders
 * columns from the live set, so an orphan would be invisible-but-present and grow the response
 * forever. Filtering here — rather than deleting the rows — is what preserves the revive path.
 */
export function liveFieldValues<T extends { readonly field_id: unknown }>(
    values: readonly T[],
    fields: readonly { readonly id: number }[],
): T[] {
    const live = new Set(fields.map((field) => field.id));
    return values.filter((value) => live.has(Number(value.field_id)));
}

/**
 * Directus serialises a MySQL `DATETIME` as `2026-09-17T14:13:17` — the stored wall clock, but
 * with an ISO separator. The module's contract is the `YYYY-MM-DD HH:mm:ss` shape the timestamps
 * were written in, and the `T` form is easy to mistake for a UTC conversion, so it is normalised
 * here. The instant is untouched: no zone is applied in either direction.
 *
 * Shared with `./assignee-service`, so every timestamp this feature puts on the wire has one
 * producer.
 */
export function toPhTimestamp(value: unknown): string | null {
    return typeof value === "string" ? value.replace("T", " ") : null;
}

/** Projects one raw row onto the wire shape; labels resolve from live catalog rows only. */
export function toClientRow(source: TaskRowSource, shaping: RowShaping): TaskClientRow {
    const row = source.row;
    const statusId = toNumberOrNull(row.status_id);
    const priorityId = toNumberOrNull(row.priority_id);
    const status = statusId === null ? null : shaping.statuses.get(statusId) ?? null;
    const priority = priorityId === null ? null : shaping.priorities.get(priorityId) ?? null;

    return {
        id: row.id,
        department_id: toNumber(row.department_id),
        parent_id: toNumberOrNull(row.parent_id),
        list_id: toNumber(row.list_id),
        status_id: toNumber(row.status_id),
        priority_id: toNumber(row.priority_id),
        title: typeof row.title === "string" ? row.title : "",
        description: typeof row.description === "string" ? row.description : null,
        start_date: typeof row.start_date === "string" ? row.start_date : null,
        end_date: typeof row.end_date === "string" ? row.end_date : null,
        sort_order: toNumber(row.sort_order),
        created_at: toPhTimestamp(row.created_at),
        created_by: toNumberOrNull(row.created_by),
        updated_at: toPhTimestamp(row.updated_at),
        updated_by: toNumberOrNull(row.updated_by),
        assignees: source.assignees,
        attachments: source.attachments,
        custom_values: source.values.map((value) => ({
            field_id: value.field_id,
            value: value.value,
        })),
        can_edit: shaping.permissions.canEditThisTask({ created_by: row.created_by }),
        can_delete: shaping.permissions.canDeleteThisTask({ created_by: row.created_by }),
        status_label: status?.label ?? null,
        status_color: status?.color ?? null,
        status_icon: normalizeIconName(status?.icon),
        priority_label: priority?.label ?? null,
        priority_color: priority?.color ?? null,
        priority_icon: normalizeIconName(priority?.icon),
    };
}

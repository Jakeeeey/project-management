"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CapabilitiesSchema, type Capabilities } from "../types/capabilities";
import { normalizeIconName } from "../components/catalog-icon";

/**
 * The client hook behind the department task list.
 *
 * One route, one shape: every call goes to `/api/project-management/task-management/tasks` with `cache: "no-store"` —
 * never an `Authorization` header, because the browser already sends the session cookie and the route
 * resolves the actor from it. The route answers with the department's **flat** rows (the tree is
 * assembled by `useTaskTree`), both catalog lists, and the actor's capabilities.
 *
 * Capabilities are READ from the route payload, never computed here: a plain member is told
 * `canAssign: false` / `canConfigure: false` by the server, and the UI hides those controls. Delete
 * is not a coarse flag on this payload — every row carries the server-computed `can_delete`, which
 * is the only thing the delete action may be gated on.
 *
 * Statuses and priorities are DATA: the rows carry the catalog labels/colours the server already
 * resolved from **live** catalog rows (an id that no longer resolves arrives as `null` and renders
 * the neutral placeholder), and `catalogs` carries the pickers' options. Nothing here maps an id to
 * a name — a hardcoded status/priority list is exactly what the plan forbids.
 *
 * Mutation strategy is owned by `useTaskMutations` / `useAssignees`: **refetch after mutate**, with
 * `refresh` as the one fetcher alias. There is no optimistic patching anywhere in this module.
 *
 * Errors surface twice on purpose: a toast for the moment, and the persistent `error` state the tree
 * renders in an alert. Server messages arrive as `CODE: message` (the service's `TaskServiceError`
 * shape) and the code prefix is stripped before a human ever sees it.
 */

const ENDPOINT = "/api/project-management/task-management/tasks";

/** The services throw `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

/** Both catalogs empty until the first successful load — never `undefined`, so consumers can read `.length`. */
const EMPTY_CATALOGS: TaskCatalogs = { statuses: [], priorities: [] };

const EMPTY_FIELDS: TaskField[] = [];

/** A status or priority catalog row as the tasks route returns it (live rows only). */
export interface TaskCatalogOption {
    readonly id: number;
    readonly label: string;
    /** Stored 6-digit hex (`#16a34a`) or `null` — rendered as an inline style, never a class. */
    readonly color: string | null;
    /** Allow-listed lucide icon name, or `null` — resolved through `normalizeIconName`. */
    readonly icon: string | null;
    readonly sort_order: number;
    readonly is_default: boolean;
}

/** The department's two catalog lists — one model per kind, as the configuration section presents them. */
export interface TaskCatalogs {
    readonly statuses: readonly TaskCatalogOption[];
    readonly priorities: readonly TaskCatalogOption[];
}

/**
 * A status or priority reference resolved by the server. `label` is the catalog row's stored text;
 * `color` its stored hex. An unresolved reference is `null` on the row — never a stale label.
 */
export interface TaskCatalogRef {
    readonly label: string;
    readonly color: string | null;
    /** Allow-listed icon name the server resolved, or `null` — never a name outside the allow-list. */
    readonly icon?: string | null;
}

/** One assigned member as the wire carries them: the id only — the directory (useAssignees) names them. */
export interface TaskAssigneeRef {
    readonly user_id: number;
}

/** One attachment on a task row, narrowed to what the attachment UI reads. */
export interface TaskAttachmentRef {
    readonly id: number;
    readonly file_id: string;
    readonly file_name: string | null;
    readonly file_type: string | null;
    readonly file_size: number | null;
    readonly sort_order: number;
}

/** The four kinds of custom column the app can render; an unknown value degrades to `text`. */
export type TaskFieldType = "text" | "number" | "date" | "select";

/** One choice a `select` column offers. */
export interface TaskFieldOption {
    readonly id: number;
    readonly label: string;
    /** Stored 6-digit hex, or `null` — rendered as an inline style, never a class. */
    readonly color: string | null;
    /** Allow-listed lucide icon name, or `null` — resolved through `normalizeIconName`. */
    readonly icon: string | null;
    readonly sort_order: number;
}

/** One custom column the department added to its task list. */
export interface TaskField {
    readonly id: number;
    readonly label: string;
    readonly field_type: TaskFieldType;
    readonly sort_order: number;
    /** When false the column is hidden from the task list and form, but keeps every stored answer. */
    readonly is_enabled: boolean;
    /** The answer a NEW task inherits, or `null` for none. A Choice column holds the option id. */
    readonly default_value: string | null;
    readonly options: readonly TaskFieldOption[];
}

/** One task's answer for one custom column. `value` is the stored text — an option id for a `select`. */
export interface TaskFieldValue {
    readonly field_id: number;
    readonly value: string | null;
}

/**
 * One task row as the list route returns it.
 *
 * `parent_id` / `sort_order` are the adjacency-list keys `buildTree` needs; `status` / `priority`
 * arrive already resolved (or `null`); `can_delete` is the server's per-row delete answer.
 */
export interface TaskListItem {
    readonly id: number;
    readonly parent_id: number | null;
    /** The task's list — the view dimension the switcher will filter on; every task carries one. */
    readonly list_id: number;
    readonly sort_order: number;
    readonly title: string;
    readonly description: string | null;
    readonly start_date: string | null;
    readonly end_date: string | null;
    readonly status_id: number;
    readonly priority_id: number;
    readonly status: TaskCatalogRef | null;
    readonly priority: TaskCatalogRef | null;
    /** The server's per-row edit answer: head, granted access, or this task's creator. */
    readonly can_edit: boolean;
    /** The server's per-row delete answer: head, granted access, or this task's creator. */
    readonly can_delete: boolean;
    readonly assignees: readonly TaskAssigneeRef[];
    readonly attachments: readonly TaskAttachmentRef[];
    /** This task's answers for the department's custom columns; a column with no answer is absent. */
    readonly custom_values: readonly TaskFieldValue[];
    readonly created_at: string | null;
    readonly created_by: number | null;
    readonly updated_at: string | null;
    readonly updated_by: number | null;
}

/** The canonical return of the tasks list hook. */
export interface UseTasksResult {
    /** The department's live rows, **flat** and sorted by `(sort_order, id)` server-side. */
    readonly items: TaskListItem[];
    /** Both per-department catalogs — the pickers and filters' only source of options. */
    readonly catalogs: TaskCatalogs;
    /** The department's live custom columns, ordered by `(sort_order, id)` — the list's extra columns. */
    readonly fields: readonly TaskField[];
    /** True during the first (cold) load, which renders the tree's loading row. */
    readonly isLoading: boolean;
    /** True during a background refetch — the tree keeps its current rows on screen. */
    readonly isRefreshing: boolean;
    readonly error: string | null;
    /** Server-resolved capabilities; `null` until the first successful load. */
    readonly capabilities: Capabilities | null;
    /** The fetcher alias, standardized on `refresh`. */
    readonly refresh: () => Promise<void>;
}

/** `true` for every `TINYINT(1)` shape Directus can hand back; `false` for anything unexpected. */
function readFlag(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
    return false;
}

/** Strips the service's `VALIDATION_FAILED:` / `FORBIDDEN:` code so the UI never shows machine text. */
function stripCode(message: string): string {
    return message.replace(UPPERCASE_CODE_PREFIX, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalises an id-ish value to a positive integer; anything else resolves to `null`. */
function toPositiveInt(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** A number that keeps its 0; `NaN` collapses to 0 so an absent `sort_order` sorts first. */
function toNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** A non-blank string as-is, else `null` — `""`, whitespace and non-strings all become `null`. */
function toNullableString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The envelope's message when it is a usable string, else the caller's fallback. */
function readMessage(envelope: Record<string, unknown>, fallback: string): string {
    return typeof envelope.message === "string" && envelope.message.trim() !== ""
        ? envelope.message
        : fallback;
}

/** Reads a JSON envelope defensively: a non-JSON error body becomes `{}` rather than a throw. */
async function readEnvelope(res: Response): Promise<Record<string, unknown>> {
    const payload: unknown = await res.json().catch(() => null);
    return isRecord(payload) ? payload : {};
}

/**
 * A resolved status/priority reference, or `null`.
 *
 * The route already resolves labels from live catalog rows and sends `null` for an unresolved one;
 * a non-string label is treated the same way, so the badge can never render a blank string.
 */
function toCatalogRef(label: unknown, color: unknown, icon: unknown): TaskCatalogRef | null {
    const text = toNullableString(label);
    return text === null
        ? null
        : { label: text, color: toNullableString(color), icon: normalizeIconName(icon) };
}

/** One catalog row, dropping malformed entries rather than rendering them. */
function toCatalogOption(raw: unknown): TaskCatalogOption | null {
    if (!isRecord(raw)) return null;
    const id = toPositiveInt(raw.id);
    if (id === null) return null;
    return {
        id,
        label: typeof raw.label === "string" ? raw.label : "",
        color: toNullableString(raw.color),
        icon: normalizeIconName(raw.icon),
        sort_order: toNumber(raw.sort_order),
        is_default: readFlag(raw.is_default),
    };
}

/** A whole catalog list, defensively narrowed — a non-array becomes an empty list. */
function toCatalogOptions(raw: unknown): TaskCatalogOption[] {
    if (!Array.isArray(raw)) return [];

    const options: TaskCatalogOption[] = [];
    for (const entry of raw) {
        const option = toCatalogOption(entry);
        if (option !== null) options.push(option);
    }
    return options;
}

function toCatalogs(raw: unknown): TaskCatalogs {
    const record = isRecord(raw) ? raw : {};
    return {
        statuses: toCatalogOptions(record.statuses),
        priorities: toCatalogOptions(record.priorities),
    };
}

/** The live assignments on a row; the route already strips soft-deleted nested rows. */
function toAssigneeRefs(raw: unknown): TaskAssigneeRef[] {
    if (!Array.isArray(raw)) return [];

    const assignees: TaskAssigneeRef[] = [];
    const seen = new Set<number>();
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const userId = toPositiveInt(entry.user_id);
        if (userId === null || seen.has(userId)) continue;
        seen.add(userId);
        assignees.push({ user_id: userId });
    }
    return assignees;
}

/** The live attachments on a row, narrowed to the fields the attachment UI renders. */
function toAttachmentRefs(raw: unknown): TaskAttachmentRef[] {
    if (!Array.isArray(raw)) return [];

    const attachments: TaskAttachmentRef[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const id = toPositiveInt(entry.id);
        const fileId = toNullableString(entry.file_id);
        if (id === null || fileId === null) continue;
        attachments.push({
            id,
            file_id: fileId,
            file_name: toNullableString(entry.file_name),
            file_type: toNullableString(entry.file_type),
            file_size: Number.isFinite(Number(entry.file_size)) && entry.file_size !== null
                ? Number(entry.file_size)
                : null,
            sort_order: toNumber(entry.sort_order),
        });
    }
    return attachments;
}

/** The four known column types; anything unexpected degrades to `text` rather than rendering nothing. */
function toFieldType(value: unknown): TaskFieldType {
    return value === "number" || value === "date" || value === "select" ? value : "text";
}

/** A `select` column's choices, ordered by `(sort_order, id)`. */
function toFieldOptions(raw: unknown): TaskFieldOption[] {
    if (!Array.isArray(raw)) return [];

    const options: TaskFieldOption[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const id = toPositiveInt(entry.id);
        if (id === null) continue;
        options.push({
            id,
            label: typeof entry.label === "string" ? entry.label : "",
            color: toNullableString(entry.color),
            icon: normalizeIconName(entry.icon),
            sort_order: toNumber(entry.sort_order),
        });
    }
    return options;
}

/** The department's custom columns, each with its choices. Shared with `useTaskFields`, which loads the same rows from the builder route. */
export function parseTaskFields(raw: unknown): TaskField[] {
    if (!Array.isArray(raw)) return [];

    const fields: TaskField[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const id = toPositiveInt(entry.id);
        if (id === null) continue;
        fields.push({
            id,
            label: typeof entry.label === "string" ? entry.label : "",
            field_type: toFieldType(entry.field_type),
            sort_order: toNumber(entry.sort_order),
            // An absent flag means ENABLED: the column ships in a change of its own, so a payload
            // from before that DDL must not read as "every column is disabled".
            is_enabled: entry.is_enabled === undefined ? true : readFlag(entry.is_enabled),
            default_value: toNullableString(entry.default_value),
            options: toFieldOptions(entry.options),
        });
    }
    return fields;
}

/** One row's answers for the custom columns; a blank answer is `null`, never `""`. */
export function parseTaskFieldValues(raw: unknown): TaskFieldValue[] {
    if (!Array.isArray(raw)) return [];

    const values: TaskFieldValue[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const fieldId = toPositiveInt(entry.field_id);
        if (fieldId === null) continue;
        values.push({ field_id: fieldId, value: toNullableString(entry.value) });
    }
    return values;
}

/** Narrows an arbitrary route payload into the rows the UI renders, dropping malformed entries. */
function toTaskListItems(raw: unknown): TaskListItem[] {
    if (!Array.isArray(raw)) return [];

    const items: TaskListItem[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const id = toPositiveInt(entry.id);
        if (id === null) continue;

        items.push({
            id,
            parent_id: toPositiveInt(entry.parent_id),
            list_id: toNumber(entry.list_id),
            sort_order: toNumber(entry.sort_order),
            title: typeof entry.title === "string" ? entry.title : "",
            description: toNullableString(entry.description),
            start_date: toNullableString(entry.start_date),
            end_date: toNullableString(entry.end_date),
            status_id: toNumber(entry.status_id),
            priority_id: toNumber(entry.priority_id),
            status: toCatalogRef(entry.status_label, entry.status_color, entry.status_icon),
            priority: toCatalogRef(entry.priority_label, entry.priority_color, entry.priority_icon),
            can_edit: readFlag(entry.can_edit),
            can_delete: readFlag(entry.can_delete),
            assignees: toAssigneeRefs(entry.assignees),
            attachments: toAttachmentRefs(entry.attachments),
            custom_values: parseTaskFieldValues(entry.custom_values),
            created_at: toNullableString(entry.created_at),
            created_by: toPositiveInt(entry.created_by),
            updated_at: toNullableString(entry.updated_at),
            updated_by: toPositiveInt(entry.updated_by),
        });
    }
    return items;
}

/**
 * Loads ONE task list's rows, both catalogs and the actor's capabilities.
 *
 * @param listId The list to scope the read to, or `null` to let the server resolve the department's
 *               default list. The caller (the tasks module) passes the switcher's resolved list id;
 *               a change refetches, and the change is a COLD load so the previous list's rows never
 *               linger under the new selection.
 *
 * The hook fetches once on mount and again after every mutation (through `refresh`, which the
 * mutation hooks call as their `onChanged`). A refetch keeps the current rows on screen —
 * `isRefreshing` drives an inline indicator while `isLoading` is only the cold-load spinner — so a
 * background failure can never blank a list the user is reading.
 *
 * @returns the canonical `{ items, catalogs, isLoading, isRefreshing, error, capabilities, refresh }`
 *          surface.
 */
export function useTasks(listId: number | null = null): UseTasksResult {
    const [items, setItems] = useState<TaskListItem[]>([]);
    const [catalogs, setCatalogs] = useState<TaskCatalogs>(EMPTY_CATALOGS);
    const [fields, setFields] = useState<TaskField[]>(EMPTY_FIELDS);
    const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /**
     * Mirrors the loaded row count so `fetchTasks` can tell a cold load from a refetch without
     * taking `items` as a dependency — which would give the callback a new identity on every fetch
     * and re-run the mount effect in a loop.
     */
    const loadedCountRef = useRef(0);

    /**
     * The list the current rows were fetched for. A list change is a COLD load, not a background
     * refetch: the previous list's rows belong to another view, so the tree shows its loading state
     * instead of keeping them on screen while the new list arrives. The row count is reset too, so a
     * failed switch retries cold rather than leaving the old rows under an `isRefreshing` indicator.
     */
    const loadedListIdRef = useRef(listId);

    const fetchTasks = useCallback(async (): Promise<void> => {
        if (loadedListIdRef.current !== listId) {
            loadedListIdRef.current = listId;
            loadedCountRef.current = 0;
        }

        const coldLoad = loadedCountRef.current === 0;
        if (coldLoad) setIsLoading(true);
        else setIsRefreshing(true);

        try {
            // `list_id` is the view dimension the route scopes by. An omitted one lets the server
            // resolve the department's default list, which is the correct first-load behaviour while
            // the list switcher is still loading its options.
            const url = listId === null ? ENDPOINT : `${ENDPOINT}?list_id=${encodeURIComponent(String(listId))}`;
            const res = await fetch(url, { cache: "no-store" });
            const envelope = await readEnvelope(res);
            if (!res.ok) throw new Error(readMessage(envelope, "Failed to load the tasks"));

            const nextItems = toTaskListItems(envelope.data);
            loadedCountRef.current = nextItems.length;
            setItems(nextItems);
            setCatalogs(toCatalogs(envelope.catalogs));
            setFields(parseTaskFields(envelope.fields));

            const parsed = CapabilitiesSchema.safeParse(envelope.capabilities);
            setCapabilities(parsed.success ? parsed.data : null);
            setError(null);
        } catch (err: unknown) {
            const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
            setError(message);
            toast.error("Tasks unavailable", { description: message });
        } finally {
            if (coldLoad) setIsLoading(false);
            else setIsRefreshing(false);
        }
    }, [listId]);

    const refresh = useCallback(async (): Promise<void> => {
        await fetchTasks();
    }, [fetchTasks]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    /**
     * The default-list ensure moved to `useTaskLists`, which owns the list resource: it boots the
     * department's "General" row and refetches the list set, and this read then refetches on its own
     * because the resolved list id changed. Keeping it here would have left the switcher's list set
     * stale for a department whose very first visit created the list.
     */

    return {
        items,
        catalogs,
        fields,
        isLoading,
        isRefreshing,
        error,
        capabilities,
        refresh,
    };
}

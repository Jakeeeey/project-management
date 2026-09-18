"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { normalizeIconName } from "../../tasks/components/catalog-icon";

import { CapabilitiesSchema, type Capabilities } from "../types/capabilities";

import type { CatalogKind } from "../types/task-config.schema";

/**
 * The client hook behind the Settings → Task configuration section.
 *
 * One route, one shape: every call goes to `/api/project-management/task-management/configure` with only
 * `Content-Type: application/json` — never an `Authorization` header, because the browser already
 * sends the session cookie and the route resolves the actor from it. Capabilities are READ from the
 * route payload, never computed here: a plain member is told `canConfigure: false` by the server and
 * the section renders nothing.
 *
 * Mutation strategy is single and fixed: **refetch after mutate**. There is no optimistic patching
 * anywhere in this module, so the list can never drift from the server's answer.
 *
 * Errors surface twice on purpose: a toast for the moment, and the persistent `error` state the
 * section renders in an alert. Server messages arrive as `CODE: message` (the service's
 * `TaskConfigError` shape) and the code prefix is stripped before a human ever sees it.
 */

/** The service throws `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;
const DEFAULT_SEED_MESSAGE = "Default statuses and priorities are ready";

/** A live catalog row, narrowed to what the configuration UI actually reads. */
export interface CatalogItem {
    readonly id: number;
    readonly label: string;
    /** Stored 6-digit hex (`#16a34a`) or `null` — rendered as an inline style, never a class. */
    readonly color: string | null;
    /** Allow-listed lucide icon name, or `null` — normalised from the API row. */
    readonly icon: string | null;
    readonly sort_order: number;
    readonly is_default: boolean;
}

/** A catalog row tagged with the table it belongs to — the combined `items` collection. */
export type CatalogItemWithKind = CatalogItem & { readonly kind: CatalogKind };

/** The editable fields of one catalog row, as the dialog collects them. */
export interface CatalogFormInput {
    readonly label: string;
    readonly color: string | null;
    /**
     * Allow-listed icon name, or `null`. OPTIONAL so a caller that only edits a label (or the row's
     * `is_default`) keeps compiling without naming an icon — an omitted key leaves the stored icon
     * untouched server-side, which is different from sending `null` to clear it.
     */
    readonly icon?: string | null;
    readonly is_default: boolean;
}

/** Reorder direction for the keyboard-accessible up/down controls. */
export type CatalogMoveDirection = "up" | "down";

type HttpMethod = "POST" | "PATCH" | "DELETE";

/** The canonical return of this module's only hook. */
export interface UseTaskConfigurationResult {
    /** The department's live statuses, ordered by `(sort_order, id)`. */
    readonly statuses: CatalogItem[];
    /** The department's live priorities, ordered by `(sort_order, id)`. */
    readonly priorities: CatalogItem[];
    /** Both kinds combined and kind-tagged — the canonical `items` collection. */
    readonly items: CatalogItemWithKind[];
    readonly isLoading: boolean;
    /** True while one of the mutations below is in flight. */
    readonly isSubmitting: boolean;
    readonly error: string | null;
    /** Server-resolved capabilities; `null` until the first successful load. */
    readonly capabilities: Capabilities | null;
    /** The fetcher alias, standardized on `refresh`. */
    readonly refresh: () => Promise<void>;
    readonly createItem: (kind: CatalogKind, input: CatalogFormInput) => Promise<boolean>;
    readonly updateItem: (
        kind: CatalogKind,
        id: number,
        changes: CatalogFormInput,
        label: string,
    ) => Promise<boolean>;
    readonly deleteItem: (kind: CatalogKind, id: number, label: string) => Promise<boolean>;
    readonly setDefault: (kind: CatalogKind, id: number, label: string) => Promise<boolean>;
    readonly moveItem: (kind: CatalogKind, id: number, direction: CatalogMoveDirection) => Promise<boolean>;
    /**
     * The department's configuration seed, explicit and head-gated — never implicit on load: it
     * writes a whole fixture (statuses, priorities, columns) and so expresses policy the head must
     * choose. The one write the app ensures implicitly is the decision-free default task list
     * (`POST /tasks/bootstrap`): a single fixed row, so the actor chooses nothing.
     */
    readonly seedDefaults: () => Promise<boolean>;
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

/** Narrows an arbitrary Directus payload into the rows the UI renders, dropping malformed entries. */
function toCatalogItems(raw: unknown): CatalogItem[] {
    if (!Array.isArray(raw)) return [];

    const items: CatalogItem[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;

        const id = Number(entry.id);
        if (!Number.isFinite(id)) continue;

        items.push({
            id,
            label: typeof entry.label === "string" ? entry.label : "",
            color: typeof entry.color === "string" && entry.color.trim() !== "" ? entry.color : null,
            icon: normalizeIconName(entry.icon),
            sort_order: Number(entry.sort_order) || 0,
            is_default: readFlag(entry.is_default),
        });
    }
    return items;
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

/** Human label for a kind, so components never re-derive their own copy. */
export function kindLabel(kind: CatalogKind): string {
    return kind === "status" ? "Status" : "Priority";
}

/** Plural human label for a kind — used for list headings and empty states. */
export function kindPlural(kind: CatalogKind): string {
    return kind === "status" ? "Statuses" : "Priorities";
}

/**
 * Loads the department's two catalog lists and the actor's capabilities.
 *
 * The hook fetches once on mount and again after every mutation. `items` is derived so consumers
 * that want a single collection (counts, future filter sources) do not have to merge the two lists
 * themselves; the two lists stay separate because statuses and priorities are one model per kind.
 */
export function useTaskConfiguration(): UseTaskConfigurationResult {
    const [statuses, setStatuses] = useState<CatalogItem[]>([]);
    const [priorities, setPriorities] = useState<CatalogItem[]>([]);
    const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchConfig = useCallback(async (showLoading: boolean): Promise<void> => {
        if (showLoading) setIsLoading(true);
        try {
            const res = await fetch("/api/project-management/task-management/configure", { cache: "no-store" });
            const envelope = await readEnvelope(res);
            if (!res.ok) throw new Error(readMessage(envelope, "Failed to load the task configuration"));

            const data = isRecord(envelope.data) ? envelope.data : {};
            setStatuses(toCatalogItems(data.statuses));
            setPriorities(toCatalogItems(data.priorities));

            const parsed = CapabilitiesSchema.safeParse(envelope.capabilities);
            setCapabilities(parsed.success ? parsed.data : null);
            setError(null);
        } catch (err: unknown) {
            const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
            setError(message);
            toast.error("Task configuration unavailable", { description: message });
        } finally {
            if (showLoading) setIsLoading(false);
        }
    }, []);

    const refresh = useCallback(async (): Promise<void> => {
        await fetchConfig(true);
    }, [fetchConfig]);

    /** Fires one request, reads the envelope, and throws the server message when it failed. */
    const request = useCallback(
        async (method: HttpMethod, body?: unknown, action?: string): Promise<Record<string, unknown>> => {
            const url = action
                ? `/api/project-management/task-management/configure?action=${encodeURIComponent(action)}`
                : "/api/project-management/task-management/configure";

            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });

            const envelope = await readEnvelope(res);
            if (!res.ok) throw new Error(readMessage(envelope, "The catalog operation could not be completed"));
            return envelope;
        },
        [],
    );

    /** Every mutation runs through here: act, refetch, toast, and record the persistent error. */
    const runMutation = useCallback(
        async (action: () => Promise<unknown>, successMessage: string): Promise<boolean> => {
            setIsSubmitting(true);
            try {
                await action();
                await fetchConfig(false);
                setError(null);
                toast.success(successMessage);
                return true;
            } catch (err: unknown) {
                const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
                setError(message);
                toast.error("Task configuration", { description: message });
                return false;
            } finally {
                setIsSubmitting(false);
            }
        },
        [fetchConfig],
    );

    const createItem = useCallback(
        async (kind: CatalogKind, input: CatalogFormInput): Promise<boolean> => {
            const list = kind === "status" ? statuses : priorities;
            const sortOrder = list.reduce((highest, row) => Math.max(highest, row.sort_order), -1) + 1;

            return runMutation(
                () => request("POST", { kind, ...input, sort_order: sortOrder }),
                `${input.label} added as a ${kind}`,
            );
        },
        [statuses, priorities, request, runMutation],
    );

    const updateItem = useCallback(
        async (
            kind: CatalogKind,
            id: number,
            changes: CatalogFormInput,
            label: string,
        ): Promise<boolean> =>
            runMutation(() => request("PATCH", { kind, id, ...changes }), `${label} updated`),
        [request, runMutation],
    );

    const deleteItem = useCallback(
        async (kind: CatalogKind, id: number, label: string): Promise<boolean> =>
            runMutation(() => request("DELETE", { kind, id }), `${label} removed`),
        [request, runMutation],
    );

    const setDefault = useCallback(
        async (kind: CatalogKind, id: number, label: string): Promise<boolean> =>
            runMutation(
                () => request("PATCH", { kind, id, is_default: true }),
                `${label} is now the default ${kind}`,
            ),
        [request, runMutation],
    );

    /**
     * Reorders one row by one position. The list is renumbered with sequential `sort_order` values
     * and only the rows whose position actually changed are written, so a swap of two adjacent rows
     * on an already-sequential list is exactly two writes.
     */
    const moveItem = useCallback(
        async (kind: CatalogKind, id: number, direction: CatalogMoveDirection): Promise<boolean> => {
            const list = kind === "status" ? statuses : priorities;
            const index = list.findIndex((row) => row.id === id);
            const target = direction === "up" ? index - 1 : index + 1;

            if (index < 0 || target < 0 || target >= list.length) return false;

            const reordered = [...list];
            const moved = reordered[index];
            reordered[index] = reordered[target];
            reordered[target] = moved;

            return runMutation(async () => {
                for (let position = 0; position < reordered.length; position += 1) {
                    const row = reordered[position];
                    if (row.sort_order === position) continue;
                    await request("PATCH", { kind, id: row.id, sort_order: position });
                }
            }, "Order updated");
        },
        [statuses, priorities, request, runMutation],
    );

    const seedDefaults = useCallback(async (): Promise<boolean> => {
        setIsSubmitting(true);
        try {
            const envelope = await request("POST", undefined, "seed-defaults");
            await fetchConfig(false);
            setError(null);
            toast.success("Seed defaults", {
                description: stripCode(readMessage(envelope, DEFAULT_SEED_MESSAGE)),
            });
            return true;
        } catch (err: unknown) {
            const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
            setError(message);
            toast.error("Seed defaults failed", { description: message });
            return false;
        } finally {
            setIsSubmitting(false);
        }
    }, [request, fetchConfig]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const items = useMemo<CatalogItemWithKind[]>(
        () => [
            ...statuses.map((row) => ({ ...row, kind: "status" as const })),
            ...priorities.map((row) => ({ ...row, kind: "priority" as const })),
        ],
        [statuses, priorities],
    );

    return {
        statuses,
        priorities,
        items,
        isLoading,
        isSubmitting,
        error,
        capabilities,
        refresh,
        createItem,
        updateItem,
        deleteItem,
        setDefault,
        moveItem,
        seedDefaults,
    };
}

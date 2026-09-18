"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { CapabilitiesSchema, type Capabilities } from "../types/capabilities";

/**
 * The client hook behind the department's task lists.
 *
 * One route, one shape: every read and write goes to
 * `/api/project-management/task-management/lists` with only `Content-Type: application/json` — never
 * an `Authorization` header, because the browser already sends the session cookie and the route
 * resolves the actor from it. `GET` answers the department's LIVE lists ordered by `(sort_order,
 * id)` plus the actor's capabilities; `POST` / `PATCH` / `DELETE` carry the row in the BODY (the
 * route has no `[id]` segment), and the three writes are head-gated server-side.
 *
 * This hook owns the module's ONE implicit write: the idempotent default-list bootstrap. It lives
 * here rather than in `useTasks` because it is a LIST concern — when the server reports it actually
 * created the "General" row, this hook refetches the list set, and the tasks read (which is scoped
 * to the selected list) then refetches on its own because its list id changed. The bootstrap is
 * fired once per mount and never awaited into the render path: a failure is swallowed (the next
 * mount retries; a task create would surface the real problem).
 *
 * Capabilities are READ from the route payload, never computed here: the task-list CRUD route's
 * `assertCanManageLists` rides the head-only `canManageDepartmentSetting` fact, so a plain member is
 * told `false` by the server and both the "Manage lists" link and the Configure section hide
 * themselves.
 *
 * Mutation strategy is the module's single one: **refetch after mutate**. Nothing is patched
 * optimistically, so the list set can never drift from the server's answer.
 */

/** The one endpoint this hook reads and writes. */
const ENDPOINT = "/api/project-management/task-management/lists";

/** The idempotent ensure for the department's default task list — POSTed once per mount. */
const BOOTSTRAP_ENDPOINT = "/api/project-management/task-management/tasks/bootstrap";

/** The services throw `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

type HttpMethod = "POST" | "PATCH" | "DELETE";

/** One live task list as the switcher and the configuration section read it. */
export interface TaskListSummary {
    readonly id: number;
    readonly name: string;
    readonly sort_order: number;
    /** The department's effective default — the row flagged in the table (server-owned). */
    readonly is_default: boolean;
}

/** Reorder direction for the keyboard-accessible up/down controls. */
export type TaskListMoveDirection = "up" | "down";

/** The canonical return of this module's list hook. */
export interface UseTaskListsResult {
    /** The department's live lists, ordered by `(sort_order, id)` — the switcher's only source. */
    readonly lists: TaskListSummary[];
    readonly isLoading: boolean;
    /** True while one of the mutations below is in flight. */
    readonly isSubmitting: boolean;
    readonly error: string | null;
    /** Server-resolved capabilities; `null` until the first successful load. */
    readonly capabilities: Capabilities | null;
    /** The fetcher alias, standardized on `refresh`. */
    readonly refresh: () => Promise<void>;
    readonly createList: (name: string) => Promise<boolean>;
    readonly renameList: (id: number, name: string) => Promise<boolean>;
    readonly moveList: (id: number, direction: TaskListMoveDirection) => Promise<boolean>;
    readonly deleteList: (id: number, name: string) => Promise<boolean>;
}

/** `true` for every `TINYINT(1)` shape Directus can hand back; `false` for anything unexpected. */
function readFlag(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
    return false;
}

/** Strips the service's `VALIDATION_FAILED:` / `NOT_FOUND:` code so the UI never shows machine text. */
function stripCode(message: string): string {
    return message.replace(UPPERCASE_CODE_PREFIX, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
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

/** Narrows an arbitrary route payload into the rows the UI renders, dropping malformed entries. */
function toTaskListSummaries(raw: unknown): TaskListSummary[] {
    if (!Array.isArray(raw)) return [];

    const lists: TaskListSummary[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;

        const id = Number(entry.id);
        if (!Number.isInteger(id) || id <= 0) continue;

        lists.push({
            id,
            name: typeof entry.name === "string" ? entry.name : "",
            sort_order: Number(entry.sort_order) || 0,
            is_default: readFlag(entry.is_default),
        });
    }
    return lists;
}

/**
 * Loads the department's live task lists and the actor's capabilities.
 *
 * The hook fetches once on mount (alongside the one-shot bootstrap) and again after every mutation.
 */
export function useTaskLists(): UseTaskListsResult {
    const [lists, setLists] = useState<TaskListSummary[]>([]);
    const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchLists = useCallback(async (showLoading: boolean): Promise<void> => {
        if (showLoading) setIsLoading(true);
        try {
            const res = await fetch(ENDPOINT, { cache: "no-store" });
            const envelope = await readEnvelope(res);
            if (!res.ok) throw new Error(readMessage(envelope, "Failed to load the task lists"));

            setLists(toTaskListSummaries(envelope.data));

            const parsed = CapabilitiesSchema.safeParse(envelope.capabilities);
            setCapabilities(parsed.success ? parsed.data : null);
            setError(null);
        } catch (err: unknown) {
            const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
            setError(message);
            toast.error("Task lists unavailable", { description: message });
        } finally {
            if (showLoading) setIsLoading(false);
        }
    }, []);

    const refresh = useCallback(async (): Promise<void> => {
        await fetchLists(true);
    }, [fetchLists]);

    /** One write request: envelope read defensively, the server's message thrown when it failed. */
    const request = useCallback(
        async (method: HttpMethod, body: unknown): Promise<Record<string, unknown>> => {
            const res = await fetch(ENDPOINT, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            const envelope = await readEnvelope(res);
            // 201 covers create; rename, reorder and delete answer 200 — `res.ok` is the whole test.
            if (!res.ok) throw new Error(readMessage(envelope, "The task-list operation could not be completed"));
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
                await fetchLists(false);
                setError(null);
                toast.success(successMessage);
                return true;
            } catch (err: unknown) {
                const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
                setError(message);
                toast.error("Task lists", { description: message });
                return false;
            } finally {
                setIsSubmitting(false);
            }
        },
        [fetchLists],
    );

    const createList = useCallback(
        async (name: string): Promise<boolean> => {
            // New lists go last: the department's own order is `(sort_order, id)`, so the highest
            // stored position plus one keeps an added list after every existing one.
            const sortOrder = lists.reduce((highest, row) => Math.max(highest, row.sort_order), -1) + 1;
            return runMutation(() => request("POST", { name, sort_order: sortOrder }), `${name} added`);
        },
        [lists, request, runMutation],
    );

    const renameList = useCallback(
        async (id: number, name: string): Promise<boolean> =>
            runMutation(() => request("PATCH", { id, name }), `${name} renamed`),
        [request, runMutation],
    );

    const deleteList = useCallback(
        async (id: number, name: string): Promise<boolean> =>
            runMutation(() => request("DELETE", { id }), `${name} removed`),
        [request, runMutation],
    );

    /**
     * Reorders one list by one position. The set is renumbered with sequential `sort_order` values
     * and only the rows whose position actually changed are written, so a swap of two adjacent rows
     * on an already-sequential list is exactly two writes. The default list is NOT special here: it
     * may sit anywhere in the order — only its removal is refused.
     */
    const moveList = useCallback(
        async (id: number, direction: TaskListMoveDirection): Promise<boolean> => {
            const index = lists.findIndex((row) => row.id === id);
            const target = direction === "up" ? index - 1 : index + 1;

            if (index < 0 || target < 0 || target >= lists.length) return false;

            const reordered = [...lists];
            const moved = reordered[index];
            reordered[index] = reordered[target];
            reordered[target] = moved;

            return runMutation(async () => {
                for (let position = 0; position < reordered.length; position += 1) {
                    const row = reordered[position];
                    if (row.sort_order === position) continue;
                    await request("PATCH", { id: row.id, sort_order: position });
                }
            }, "Order updated");
        },
        [lists, request, runMutation],
    );

    /**
     * The ONE implicit write the client triggers: ensure the department's default task list exists,
     * so a department whose head never ran the configuration seed can still create tasks. Fired once
     * per mount and never awaited into the render path; the list read above paints independently.
     *
     * The refetch runs only when the server reports it actually created the row; a no-op changes
     * nothing, so there is nothing to refresh.
     */
    useEffect(() => {
        let cancelled = false;

        void (async (): Promise<void> => {
            try {
                const res = await fetch(BOOTSTRAP_ENDPOINT, { method: "POST", cache: "no-store" });
                if (!res.ok) return;

                const envelope = await readEnvelope(res);
                const data = isRecord(envelope.data) ? envelope.data : {};
                if (!cancelled && data.created === true) await refresh();
            } catch {
                // Best effort by design: a failed bootstrap must never break the page.
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [refresh]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return {
        lists,
        isLoading,
        isSubmitting,
        error,
        capabilities,
        refresh,
        createList,
        renameList,
        moveList,
        deleteList,
    };
}

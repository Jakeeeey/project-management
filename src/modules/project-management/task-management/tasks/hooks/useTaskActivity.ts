"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The client hook behind one task's change history.
 *
 * One route, one shape: `GET /api/project-management/task-management/tasks/<id>/activity` answers
 * `{ success, data: TaskActivityEntry[] }` — this task's rows, newest-first, already
 * department-scoped and already normalised server-side. The hook fetches with `cache: "no-store"`
 * and never sends an `Authorization` header, because the browser already sends the session cookie
 * and the route resolves the actor from it.
 *
 * The rows are SNAPSHOTS: `old_label` / `new_label` are the display text captured when the change
 * happened, and this hook hands them through untouched. It never looks an id up against a live
 * catalog — a later rename must not rewrite the past.
 *
 * Fetching only happens while a task is actually on screen (`taskId !== null`), and a failed
 * request is deliberately QUIET: the history is a secondary surface, so the hook records a message
 * for the timeline to render and never throws, toasts, or blanks the sheet around it. A stale
 * response from a previous task is dropped through an `AbortController`.
 */

/** The tasks collection route; one task's history hangs off it. */
const TASKS_ENDPOINT = "/api/project-management/task-management/tasks";

/** Rows requested per page. The route clamps this too, so neither end can ask for the whole trail. */
const PAGE_SIZE = 20;

/** The services throw `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

/**
 * One `pm_task_activity` row as the route hands it over.
 *
 * Rows sharing a `batch_id` were written by one logical save and share `actor_label` / `changed_at`.
 * A `null` `new_value` means the field was cleared (or, on a create, never set) — never "changed to
 * null". A `null` label means "no display text for this value" and is NOT filled in here.
 */
export interface TaskActivityEntry {
    readonly id: number;
    /** Rows inserted by one logical save share this; `null` only for a pre-batch legacy row. */
    readonly batch_id: string | null;
    readonly action: string;
    readonly field_key: string;
    /** The `pm_task_field.id` when `field_key = 'custom'`, else `null`. */
    readonly field_id: number | null;
    /** The built-in label, or a custom column's name AT THE TIME of the change. Always display this. */
    readonly field_label: string;
    readonly old_value: string | null;
    readonly new_value: string | null;
    readonly old_label: string | null;
    readonly new_label: string | null;
    readonly actor_id: number | null;
    readonly actor_label: string | null;
    readonly changed_at: string | null;
}

/** The canonical return of the task-activity hook. */
export interface UseTaskActivityResult {
    /** The pages loaded so far, newest-first. Empty until a load resolves. */
    readonly entries: readonly TaskActivityEntry[];
    /** True while the FIRST page for the current task is in flight. */
    readonly isLoading: boolean;
    /** True while a `loadMore` append is in flight. */
    readonly isLoadingMore: boolean;
    /** A quiet, human message when the history could not be loaded; `null` on success. */
    readonly error: string | null;
    /** True when an older page exists on the server. Gates the "Load more" affordance. */
    readonly hasMore: boolean;
    /** Appends the next page; a no-op while a request is already in flight. */
    readonly loadMore: () => void;
}

/** Strips the service's `NOT_FOUND:` / `FORBIDDEN:` code so the UI never shows machine text. */
function stripCode(message: string): string {
    return message.replace(UPPERCASE_CODE_PREFIX, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A non-blank string as-is, else `null` — `""`, whitespace and non-strings all become `null`. */
function toNullableString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Normalises an id-ish value to a positive integer; anything else resolves to `null`. */
function toPositiveInt(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Reads a JSON envelope defensively: a non-JSON error body becomes `{}` rather than a throw. */
async function readEnvelope(res: Response): Promise<Record<string, unknown>> {
    const payload: unknown = await res.json().catch(() => null);
    return isRecord(payload) ? payload : {};
}

/** The envelope's message when it is a usable string, else the caller's fallback. */
function readMessage(envelope: Record<string, unknown>, fallback: string): string {
    return typeof envelope.message === "string" && envelope.message.trim() !== ""
        ? envelope.message
        : fallback;
}

/** One row, defensively narrowed; a row without a resolvable id is dropped rather than rendered. */
function toEntry(raw: unknown): TaskActivityEntry | null {
    if (!isRecord(raw)) return null;
    const id = toPositiveInt(raw.id);
    if (id === null) return null;

    return {
        id,
        batch_id: toNullableString(raw.batch_id),
        action: typeof raw.action === "string" ? raw.action : "updated",
        field_key: typeof raw.field_key === "string" ? raw.field_key : "",
        field_id: toPositiveInt(raw.field_id),
        field_label: typeof raw.field_label === "string" ? raw.field_label : "",
        old_value: toNullableString(raw.old_value),
        new_value: toNullableString(raw.new_value),
        old_label: toNullableString(raw.old_label),
        new_label: toNullableString(raw.new_label),
        actor_id: toPositiveInt(raw.actor_id),
        actor_label: toNullableString(raw.actor_label),
        changed_at: toNullableString(raw.changed_at),
    };
}

/** A whole payload, defensively narrowed — a non-array becomes an empty history. */
function toEntries(raw: unknown): TaskActivityEntry[] {
    if (!Array.isArray(raw)) return [];

    const entries: TaskActivityEntry[] = [];
    for (const candidate of raw) {
        const entry = toEntry(candidate);
        if (entry !== null) entries.push(entry);
    }
    return entries;
}

/** One page as the route hands it over: the rows plus whether an older page remains. */
interface ActivityPage {
    readonly entries: TaskActivityEntry[];
    readonly hasMore: boolean;
}

/**
 * Fetches one bounded page. `hasMore` comes from the envelope's top-level flag, which the route
 * derives from a `limit + 1` sentinel row — the client never issues a second request to find out.
 */
async function fetchPage(taskId: number, offset: number, signal: AbortSignal): Promise<ActivityPage> {
    const res = await fetch(`${TASKS_ENDPOINT}/${taskId}/activity?limit=${PAGE_SIZE}&offset=${offset}`, {
        cache: "no-store",
        signal,
    });
    const envelope = await readEnvelope(res);
    if (!res.ok) throw new Error(readMessage(envelope, "Failed to load the task history"));

    return { entries: toEntries(envelope.data), hasMore: envelope.hasMore === true };
}

/**
 * Loads one task's change history one page at a time.
 *
 * The effect is keyed on `taskId`, so opening a different task RESETS to the first page, refetches,
 * and aborts a pending request for the previous task. `loadMore` appends one older page; it is a
 * no-op while a request is already in flight (a ref guards a same-tick double click, and the control
 * is disabled meanwhile). A failed FIRST load records `error` and leaves `entries` empty; a failed
 * append keeps the rows already on screen and stays quiet, so the surface a user is reading is never
 * blanked by a secondary failure.
 *
 * @param taskId the task whose history to show, or `null` when the sheet is showing nothing.
 * @returns the canonical `{ entries, isLoading, isLoadingMore, error, hasMore, loadMore }` surface.
 */
export function useTaskActivity(taskId: number | null): UseTaskActivityResult {
    const [entries, setEntries] = useState<readonly TaskActivityEntry[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);

    const requestRef = useRef<AbortController | null>(null);
    const inFlightRef = useRef(false);

    useEffect(() => {
        requestRef.current?.abort();
        inFlightRef.current = false;

        if (taskId === null) {
            setEntries([]);
            setIsLoading(false);
            setIsLoadingMore(false);
            setError(null);
            setHasMore(false);
            return;
        }

        const controller = new AbortController();
        requestRef.current = controller;
        inFlightRef.current = true;
        setEntries([]);
        setIsLoading(true);
        setIsLoadingMore(false);
        setError(null);
        setHasMore(false);

        void (async () => {
            try {
                const page = await fetchPage(taskId, 0, controller.signal);
                if (controller.signal.aborted) return;

                setEntries(page.entries);
                setHasMore(page.hasMore);
                setError(null);
            } catch (err: unknown) {
                if (controller.signal.aborted) return;
                setEntries([]);
                setHasMore(false);
                setError(stripCode(err instanceof Error ? err.message : "An unknown error occurred"));
            } finally {
                if (!controller.signal.aborted) {
                    setIsLoading(false);
                    inFlightRef.current = false;
                }
            }
        })();

        return () => requestRef.current?.abort();
    }, [taskId]);

    const loadMore = useCallback((): void => {
        if (taskId === null || !hasMore || inFlightRef.current) return;

        const offset = entries.length;
        const controller = new AbortController();
        requestRef.current = controller;
        inFlightRef.current = true;
        setIsLoadingMore(true);

        void (async () => {
            try {
                const page = await fetchPage(taskId, offset, controller.signal);
                if (controller.signal.aborted) return;

                setEntries((previous) => [...previous, ...page.entries]);
                setHasMore(page.hasMore);
                setError(null);
            } catch {
                if (controller.signal.aborted) return;
                // Keep the rows already on screen; the control stays so the page can be retried.
                setError(null);
            } finally {
                if (!controller.signal.aborted) {
                    setIsLoadingMore(false);
                    inFlightRef.current = false;
                }
            }
        })();
    }, [taskId, hasMore, entries.length]);

    return { entries, isLoading, isLoadingMore, error, hasMore, loadMore };
}

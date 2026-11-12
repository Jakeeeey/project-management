"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import type { TaskTagOption } from "./useTasks";

/**
 * The tag hook: define the department's tags, and put them on / take them off a task.
 *
 * The tag CATALOG is not fetched here. It rides on the tasks payload (`catalogs.tags`), which the
 * module already reads on every load and refetch — a second request for the same list would be a
 * duplicate, so the catalog arrives as an argument and this hook owns only the writes. Nothing is
 * patched optimistically: every successful write awaits `onChanged`, the module's single mutation
 * strategy.
 *
 * Route contract this hook mirrors exactly:
 * - `POST   /api/project-management/task-management/configure/tags`              body `{ label, color, sort_order }`
 * - `PATCH  /api/project-management/task-management/configure/tags`              body `{ id, label?, color?, sort_order? }`
 * - `DELETE /api/project-management/task-management/configure/tags`              body `{ id }`
 * - `POST   /api/project-management/task-management/tasks/<id>/tags`   body `{ tag_id }`
 * - `DELETE /api/project-management/task-management/tasks/<id>/tags`   body `{ tag_id }`
 *
 * Every write is 200 on success. Writes send `Content-Type: application/json` only — never an
 * `Authorization` header, because the browser already sends the session cookie and the route
 * resolves the actor from it. Failure copy never exposes technical detail: the service's
 * `CODE: message` prefix is stripped, and every failure is recorded in the persistent `error` state
 * as well as toasted.
 */

/** The tag catalog route — one URL, the verb selects the operation. */
const TAGS_ENDPOINT = "/api/project-management/task-management/configure/tags";

/** The tasks collection route; the tag-assignment path hangs off one task. */
const TASKS_ENDPOINT = "/api/project-management/task-management/tasks";

/** The services throw `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

type HttpMethod = "POST" | "PATCH" | "DELETE";

/** One tag as the configuration section writes it. */
export interface TagInput {
    readonly label: string;
    /** Stored 6-digit hex, or `null` for no colour. */
    readonly color?: string | null;
    readonly sort_order?: number;
}

export interface UseTagsOptions {
    /** The department's tags — `useTasks().catalogs.tags`. */
    readonly tags: readonly TaskTagOption[];
    /**
     * Refetch the task list after every successful write — the module's single mutation strategy.
     * Pass `useTasks().refresh`; nothing is patched optimistically.
     */
    readonly onChanged: () => Promise<void>;
}

/** The canonical return of the tag hook. */
export interface UseTagsResult {
    /** The department's tags, passed through so a consumer takes them from one place. */
    readonly tags: readonly TaskTagOption[];
    /** True while any tag write is in flight. */
    readonly isSubmitting: boolean;
    /** The last tag failure's human message, kept until a later success clears it. */
    readonly error: string | null;
    /** Refetches the task list (the catalog's owner) — the writes already await `onChanged`. */
    readonly refresh: () => Promise<void>;
    /** Creates a tag. Resolves `true` on 200. */
    readonly createTag: (input: TagInput) => Promise<boolean>;
    /** Renames / recolours a tag. Resolves `true` on 200. */
    readonly updateTag: (tagId: number, input: Partial<TagInput>) => Promise<boolean>;
    /** Deletes a tag (detaching it from every task server-side). Resolves `true` on 200. */
    readonly deleteTag: (tagId: number) => Promise<boolean>;
    /** Attaches a tag to a task (revive-or-insert server-side). Resolves `true` on 200. */
    readonly assignTag: (taskId: number, tagId: number, label: string) => Promise<boolean>;
    /** Takes a tag off a task (soft delete server-side). Resolves `true` on 200. */
    readonly unassignTag: (taskId: number, tagId: number, label: string) => Promise<boolean>;
}

/** Strips the service's `FORBIDDEN:` / `NOT_FOUND:` code so the UI never shows machine text. */
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

/** One write request: envelope read defensively, the server's message thrown when it failed. */
async function request(
    url: string,
    method: HttpMethod,
    body: Record<string, unknown>,
    fallback: string,
): Promise<void> {
    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    const envelope = await readEnvelope(res);
    // 200 is the success answer for every verb (an assign may revive an existing row).
    if (!res.ok) throw new Error(readMessage(envelope, fallback));
}

/**
 * Wires the module's tag writes to their routes.
 *
 * @param options `tags` — the catalog from the tasks payload; `onChanged` — awaited after every
 *                successful write to refetch the task list.
 * @returns the canonical `{ tags, isSubmitting, error, refresh, createTag, updateTag, deleteTag,
 *          assignTag, unassignTag }` surface.
 */
export function useTags({ tags, onChanged }: UseTagsOptions): UseTagsResult {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** Every write runs through here: act, refetch, toast, and record the persistent error. */
    const runMutation = useCallback(
        async (action: () => Promise<void>, successMessage: string, failureTitle: string): Promise<boolean> => {
            setIsSubmitting(true);
            try {
                await action();
                await onChanged();
                setError(null);
                toast.success(successMessage);
                return true;
            } catch (err: unknown) {
                const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
                setError(message);
                toast.error(failureTitle, { description: message });
                return false;
            } finally {
                setIsSubmitting(false);
            }
        },
        [onChanged],
    );

    const createTag = useCallback(
        async (input: TagInput): Promise<boolean> =>
            runMutation(
                () => request(TAGS_ENDPOINT, "POST", { ...input }, "The tag could not be created"),
                `${input.label} created`,
                "Could not create the tag",
            ),
        [runMutation],
    );

    const updateTag = useCallback(
        async (tagId: number, input: Partial<TagInput>): Promise<boolean> =>
            runMutation(
                () => request(TAGS_ENDPOINT, "PATCH", { id: tagId, ...input }, "The tag could not be updated"),
                "Tag updated",
                "Could not update the tag",
            ),
        [runMutation],
    );

    const deleteTag = useCallback(
        async (tagId: number): Promise<boolean> =>
            runMutation(
                () => request(TAGS_ENDPOINT, "DELETE", { id: tagId }, "The tag could not be deleted"),
                "Tag deleted",
                "Could not delete the tag",
            ),
        [runMutation],
    );

    const assignTag = useCallback(
        async (taskId: number, tagId: number, label: string): Promise<boolean> =>
            runMutation(
                () => request(`${TASKS_ENDPOINT}/${taskId}/tags`, "POST", { tag_id: tagId }, "The tag could not be attached"),
                `${label} added`,
                "Could not add the tag",
            ),
        [runMutation],
    );

    const unassignTag = useCallback(
        async (taskId: number, tagId: number, label: string): Promise<boolean> =>
            runMutation(
                () => request(`${TASKS_ENDPOINT}/${taskId}/tags`, "DELETE", { tag_id: tagId }, "The tag could not be removed"),
                `${label} removed`,
                "Could not remove the tag",
            ),
        [runMutation],
    );

    return {
        tags,
        isSubmitting,
        error,
        refresh: onChanged,
        createTag,
        updateTag,
        deleteTag,
        assignTag,
        unassignTag,
    };
}

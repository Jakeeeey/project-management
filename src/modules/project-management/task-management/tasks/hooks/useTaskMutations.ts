"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import type {
    CreateTaskInput,
    MoveTaskInput,
    UpdateTaskInput,
} from "../types/pm-task.schema";

/**
 * The write hook behind the task tree: create, update, delete, move and attach.
 *
 * One strategy, pinned: **refetch after mutate**. Every successful call awaits `onChanged` (the
 * list's `refresh`) before it toasts, and nothing is patched optimistically — the tree can never
 * drift from the server. A failed write leaves the rows exactly as they were and surfaces the
 * server's message both as a toast and as the persistent `error` state.
 *
 * Route contract this hook mirrors exactly:
 * - `POST /api/project-management/task-management/tasks` → **201**, with the created row in `data` — that row's id
 *   is what `createTask` resolves, because a task's assignees can only be attached once the row
 *   exists.
 * - `PATCH /api/project-management/task-management/tasks/<id>` → 200.
 * - `DELETE /api/project-management/task-management/tasks/<id>` → 200 (soft delete of the whole subtree server-side).
 * - `PATCH /api/project-management/task-management/tasks/<id>/move` with `{ parent_id, sibling_ids }` → 200. The move
 *   verb is **PATCH**, not POST.
 * - `POST /api/project-management/task-management/tasks/<id>/attachments` (multipart, field `file`) → **201** with
 *   Directus's raw `{ data }` — the plan's documented envelope exception. The `Content-Type` header
 *   is deliberately NOT set, so the browser's generated multipart boundary survives.
 * - `DELETE /api/project-management/task-management/tasks/<id>/attachments?attachmentId=<id>` → 200 (soft delete; the
 *   Directus file is deliberately left in place).
 *
 * Every JSON write sends `Content-Type: application/json`; the multipart upload sends **no**
 * `Content-Type` at all. Neither sets an `Authorization` header, because the browser already sends
 * the session cookie and the route resolves the actor from it. The body types come from the module's
 * Zod schemas, so `department_id`, the audit columns and `parent_id` on an update can never be sent.
 *
 * Failure copy never exposes technical detail: the service's `CODE: message` prefix is stripped, and
 * a non-JSON/network failure becomes a plain sentence.
 */

/** The tasks collection route; the item and move paths hang off it. */
const TASKS_ENDPOINT = "/api/project-management/task-management/tasks";

/** The services throw `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

type HttpMethod = "POST" | "PATCH" | "DELETE";

export interface UseTaskMutationsOptions {
    /**
     * Refetch the list after every successful write — the module's single mutation strategy. Pass
     * `useTasks().refresh`; there is no optimistic patching anywhere, so the tree always shows the
     * server's answer.
     */
    readonly onChanged: () => Promise<void>;
}

/** The canonical return of the task write hook. */
export interface UseTaskMutationsResult {
    /** True while one of the writes below is in flight. */
    readonly isSubmitting: boolean;
    /** The last failure's human message, kept until a later success clears it. */
    readonly error: string | null;
    /**
     * Creates a task or a subtask. Resolves the **created row's id** on 201, or `null` on failure.
     *
     * The id is part of the contract on purpose: a task cannot be assigned to anyone before it
     * exists, so the create dialog needs the new row's id to attach its chosen assignees through the
     * assignees route. A `number` is truthy and `null` is falsy, so a boolean-style caller still
     * reads correctly.
     */
    readonly createTask: (input: CreateTaskInput) => Promise<number | null>;
    /** Updates a task's fields (never its parent — re-parenting goes through `moveTask`). */
    readonly updateTask: (taskId: number, input: UpdateTaskInput) => Promise<boolean>;
    /** Soft-deletes a task and its whole subtree. */
    readonly deleteTask: (taskId: number, label: string) => Promise<boolean>;
    /** Reorders or re-parents a task with the pinned `{ parent_id, sibling_ids }` payload. */
    readonly moveTask: (taskId: number, payload: MoveTaskInput) => Promise<boolean>;
    /**
     * Uploads one file to a task. The request is multipart and carries **no `Content-Type`** — the
     * browser owns the boundary — and it resolves `true` once the refetch has run.
     */
    readonly uploadAttachment: (taskId: number, file: File) => Promise<boolean>;
    /**
     * Soft-deletes one attachment link (the Directus file is kept). Resolves `true` on success.
     */
    readonly detachAttachment: (taskId: number, attachmentId: number, label: string) => Promise<boolean>;
    /** Clears the persistent error state (e.g. when the dialog closes). */
    readonly clearError: () => void;
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

/** Reads the created row's id out of a 201 envelope's `data`; anything unexpected yields `null`. */
function createdIdOf(envelope: Record<string, unknown> | null): number | null {
    const data = envelope?.data;
    if (!isRecord(data)) return null;

    const id = Number(data.id);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Wires the module's task writes to their routes.
 *
 * @param options `onChanged` — awaited after every successful write to refetch the list.
 * @returns `{ isSubmitting, error, createTask, updateTask, deleteTask, moveTask, uploadAttachment,
 *          detachAttachment, clearError }`.
 */
export function useTaskMutations({ onChanged }: UseTaskMutationsOptions): UseTaskMutationsResult {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** One write request: envelope read defensively, the server's message thrown when it failed. */
    const request = useCallback(
        async (url: string, method: HttpMethod, body: unknown): Promise<Record<string, unknown>> => {
            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });

            const envelope = await readEnvelope(res);
            // 201 covers create; every other write answers 200 — `res.ok` is the whole success test.
            if (!res.ok) throw new Error(readMessage(envelope, "The task operation could not be completed"));
            return envelope;
        },
        [],
    );

    /** Every write runs through here: act, refetch, toast, and record the persistent error. */
    const runMutation = useCallback(
        async (
            action: () => Promise<Record<string, unknown>>,
            successMessage: string,
            failureTitle: string,
        ): Promise<Record<string, unknown> | null> => {
            setIsSubmitting(true);
            try {
                const envelope = await action();
                await onChanged();
                setError(null);
                toast.success(successMessage);
                return envelope;
            } catch (err: unknown) {
                const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
                setError(message);
                toast.error(failureTitle, { description: message });
                return null;
            } finally {
                setIsSubmitting(false);
            }
        },
        [onChanged],
    );

    const createTask = useCallback(
        async (input: CreateTaskInput): Promise<number | null> => {
            const envelope = await runMutation(
                () => request(TASKS_ENDPOINT, "POST", input),
                `${input.title} created`,
                "Could not create the task",
            );
            return createdIdOf(envelope);
        },
        [request, runMutation],
    );

    const updateTask = useCallback(
        async (taskId: number, input: UpdateTaskInput): Promise<boolean> => {
            const envelope = await runMutation(
                () => request(`${TASKS_ENDPOINT}/${taskId}`, "PATCH", input),
                "Changes saved",
                "Could not save the task",
            );
            return envelope !== null;
        },
        [request, runMutation],
    );

    const deleteTask = useCallback(
        async (taskId: number, label: string): Promise<boolean> => {
            const envelope = await runMutation(
                () => request(`${TASKS_ENDPOINT}/${taskId}`, "DELETE", undefined),
                `${label} deleted`,
                "Could not delete the task",
            );
            return envelope !== null;
        },
        [request, runMutation],
    );

    const moveTask = useCallback(
        async (taskId: number, payload: MoveTaskInput): Promise<boolean> => {
            const envelope = await runMutation(
                // PATCH — the move route is deliberately not a POST.
                () => request(`${TASKS_ENDPOINT}/${taskId}/move`, "PATCH", payload),
                "Order updated",
                "Could not move the task",
            );
            return envelope !== null;
        },
        [request, runMutation],
    );

    const uploadAttachment = useCallback(
        async (taskId: number, file: File): Promise<boolean> => {
            const form = new FormData();
            form.append("file", file);

            const envelope = await runMutation(
                async () => {
                    // No headers at all: fetch must generate `multipart/form-data; boundary=...`.
                    const res = await fetch(`${TASKS_ENDPOINT}/${taskId}/attachments`, {
                        method: "POST",
                        body: form,
                    });
                    const payload = await readEnvelope(res);
                    if (!res.ok) throw new Error(readMessage(payload, "The file could not be uploaded"));
                    return payload;
                },
                `${file.name} attached`,
                "Could not upload the file",
            );
            return envelope !== null;
        },
        [runMutation],
    );

    const detachAttachment = useCallback(
        async (taskId: number, attachmentId: number, label: string): Promise<boolean> => {
            const envelope = await runMutation(
                () =>
                    request(
                        `${TASKS_ENDPOINT}/${taskId}/attachments?attachmentId=${encodeURIComponent(String(attachmentId))}`,
                        "DELETE",
                        undefined,
                    ),
                `${label} detached`,
                "Could not detach the file",
            );
            return envelope !== null;
        },
        [request, runMutation],
    );

    const clearError = useCallback((): void => {
        setError(null);
    }, []);

    return {
        isSubmitting,
        error,
        createTask,
        updateTask,
        deleteTask,
        moveTask,
        uploadAttachment,
        detachAttachment,
        clearError,
    };
}

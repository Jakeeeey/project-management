"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import {
    useAssignmentGrants,
    type MemberGrantItem,
} from "@/modules/project-management/assignment-grants/hooks/useAssignmentGrants";

/**
 * The assignee hook: put a department member on a task, take them off, and expose the member
 * directory the picker needs.
 *
 * The directory is not re-fetched here — it is the **reused** `useAssignmentGrants` hook, whose
 * `GET /api/project-management/assignment-grants` answers with the department's live members and is
 * readable by every member. That reuse is deliberate: the department has exactly one members
 * endpoint, so the tasks module reads it through the module that owns it rather than duplicating its
 * narrowing. Assigning and unassigning do **not** change the department's membership, so the writes
 * never refresh the directory — only the task list, through `onChanged`.
 *
 * Route contract this hook mirrors exactly — both verbs take the same body, `{ user_id }`:
 * - `POST /api/project-management/tasks/<id>/assignees` → **200** (revive-or-insert, so there is no
 *   single "created" answer).
 * - `DELETE /api/project-management/tasks/<id>/assignees` → **200** (soft delete; a later re-assign
 *   revives the same row).
 *
 * Both writes send `Content-Type: application/json` only — never an `Authorization` header, because
 * the browser already sends the session cookie and the route resolves the actor from it. Failure
 * copy never exposes technical detail: the service's `CODE: message` prefix is stripped, and every
 * failure is recorded in the persistent `error` state as well as toasted.
 */

/** The tasks collection route; the assignee path hangs off one task. */
const TASKS_ENDPOINT = "/api/project-management/tasks";

/** The services throw `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

type HttpMethod = "POST" | "DELETE";

export interface UseAssigneesOptions {
    /**
     * Refetch the task list after every successful write — the module's single mutation strategy.
     * Pass `useTasks().refresh`; nothing is patched optimistically.
     */
    readonly onChanged: () => Promise<void>;
}

/** The canonical return of the assignee hook. */
export interface UseAssigneesResult {
    /** The department's live members with their grant state — the assignee picker's options. */
    readonly members: readonly MemberGrantItem[];
    /** Display names keyed by user id, so the tree can name an assignee without a second request. */
    readonly memberNameById: ReadonlyMap<number, string>;
    /** True while the member directory is loading (the reused grants hook owns that request). */
    readonly isLoading: boolean;
    /** True while an assign or unassign is in flight. */
    readonly isSubmitting: boolean;
    /** The last assignment failure's human message, kept until a later success clears it. */
    readonly error: string | null;
    /** Re-reads the member directory; the writes never need it because membership does not change. */
    readonly refresh: () => Promise<void>;
    /** Assigns a member (revive-or-insert server-side). Resolves `true` on 200. */
    readonly assign: (taskId: number, userId: number, label: string) => Promise<boolean>;
    /** Takes a member off the task (soft delete server-side). Resolves `true` on 200. */
    readonly unassign: (taskId: number, userId: number, label: string) => Promise<boolean>;
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

/**
 * Wires the module's assignee writes to their route and re-exports the member directory.
 *
 * @param options `onChanged` — awaited after every successful write to refetch the task list.
 * @returns the canonical `{ members, memberNameById, isLoading, isSubmitting, error, refresh, assign,
 *          unassign }` surface.
 */
export function useAssignees({ onChanged }: UseAssigneesOptions): UseAssigneesResult {
    const directory = useAssignmentGrants();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** One write request: envelope read defensively, the server's message thrown when it failed. */
    const request = useCallback(async (taskId: number, method: HttpMethod, userId: number): Promise<void> => {
        const res = await fetch(`${TASKS_ENDPOINT}/${taskId}/assignees`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: userId }),
        });

        const envelope = await readEnvelope(res);
        // 200 is the success answer for both verbs (an assign may revive an existing row).
        if (!res.ok) throw new Error(readMessage(envelope, "The assignment could not be completed"));
    }, []);

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

    const assign = useCallback(
        async (taskId: number, userId: number, label: string): Promise<boolean> =>
            runMutation(
                () => request(taskId, "POST", userId),
                `${label} assigned`,
                "Could not assign the member",
            ),
        [request, runMutation],
    );

    const unassign = useCallback(
        async (taskId: number, userId: number, label: string): Promise<boolean> =>
            runMutation(
                () => request(taskId, "DELETE", userId),
                `${label} unassigned`,
                "Could not unassign the member",
            ),
        [request, runMutation],
    );

    return {
        members: directory.items,
        memberNameById: directory.memberNameById,
        isLoading: directory.isLoading,
        isSubmitting,
        error,
        refresh: directory.refresh,
        assign,
        unassign,
    };
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { CapabilitiesSchema, type Capabilities } from "@/modules/project-management/types/capabilities";

/**
 * The client hook behind the Assignment Grants page.
 *
 * One route, one shape: every call goes to `/api/project-management/assignment-grants` with only
 * `Content-Type: application/json` on the write paths — never an `Authorization` header, because
 * the browser already sends the session cookie and the route resolves the actor from it.
 *
 * Capabilities are READ from the route payload, never computed here. The route answers with the
 * same seven flags the rest of the module uses, and `canGrant` on that payload is the ONLY thing the
 * page gates the grant/revoke controls on — so a non-head is told `canGrant: false` by the server and
 * the controls are not rendered into the DOM at all.
 *
 * Mutation strategy is single and fixed: **refetch after mutate**. There is no optimistic patching
 * anywhere in this module, so the roster can never drift from the server's answer. Grant and revoke
 * both answer **200** (not 201): the route deliberately returns 200 for a grant because the write
 * revives an existing soft-deleted row just as often as it inserts one, so there is no single
 * "created" answer. `res.ok` is therefore the whole success test.
 *
 * Errors surface twice on purpose: a toast for the moment, and the persistent `error` state the list
 * renders in an alert. Server messages arrive as `CODE: message` (the `GrantError` shape) and the
 * code prefix is stripped before a human ever sees it.
 */

/** The one endpoint this feature talks to. */
const ENDPOINT = "/api/project-management/assignment-grants";

/** The service throws `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

type HttpMethod = "POST" | "DELETE";

/**
 * One row of the grant list: a live department member plus their active-grant state, exactly as the
 * route's `data` array delivers it.
 *
 * `grant_id` is the value a revoke names (the `pm_task_assigner` row id, never the user id);
 * `granted_by` is provenance — the user id recorded when the grant was issued, or `null`.
 */
export interface MemberGrantItem {
    readonly user_id: number;
    readonly full_name: string;
    readonly user_email: string | null;
    readonly is_granted: boolean;
    readonly grant_id: number | null;
    readonly granted_by: number | null;
}

/** The canonical return of this module's only grants hook. */
export interface UseAssignmentGrantsResult {
    /** The department's live members with their grant state — the canonical `items` collection. */
    readonly items: MemberGrantItem[];
    readonly isLoading: boolean;
    /** True while a grant or revoke is in flight. */
    readonly isSubmitting: boolean;
    readonly error: string | null;
    /** Server-resolved capabilities; `null` until the first successful load. */
    readonly capabilities: Capabilities | null;
    /**
     * Member display names keyed by user id, so `granted_by` (a bare user id on the wire) can be
     * shown as the name of the member who issued the grant without a second request. A granter who
     * is no longer in the department simply misses the map and falls back to `User #<id>`.
     */
    readonly memberNameById: ReadonlyMap<number, string>;
    /** The fetcher alias, standardized on `refresh`. */
    readonly refresh: () => Promise<void>;
    /** Grants assigner rights; resets the roster from the server on success. */
    readonly grant: (userId: number, label: string) => Promise<boolean>;
    /** Revokes a grant by its grant-row id; resets the roster from the server on success. */
    readonly revoke: (grantId: number, label: string) => Promise<boolean>;
}

/** `true` for every `TINYINT(1)` shape Directus can hand back; `false` for anything unexpected. */
function readFlag(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
    return false;
}

/** Strips the service's `NOT_FOUND:` / `INTERNAL_FAIL:` code so the UI never shows machine text. */
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

/** "Zarina Carcha" from the two-name columns, falling back to a stable id label. */
function fullNameOf(firstName: unknown, lastName: unknown): string {
    const first = typeof firstName === "string" ? firstName.trim() : "";
    const last = typeof lastName === "string" ? lastName.trim() : "";
    return [first, last].filter(Boolean).join(" ");
}

/** Narrows an arbitrary route payload into the members the UI renders, dropping malformed entries. */
function toMemberGrantItems(raw: unknown): MemberGrantItem[] {
    if (!Array.isArray(raw)) return [];

    const items: MemberGrantItem[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;

        const userId = toPositiveInt(entry.user_id);
        if (userId === null) continue;

        const isGranted = readFlag(entry.is_granted);
        const grantId = toPositiveInt(entry.grant_id);
        const email = typeof entry.user_email === "string" && entry.user_email.trim() !== ""
            ? entry.user_email.trim()
            : null;

        items.push({
            user_id: userId,
            full_name: fullNameOf(entry.user_fname, entry.user_lname) || `User #${userId}`,
            user_email: email,
            is_granted: isGranted,
            // A revoke must name the live row, so an id is only carried when a grant actually exists.
            grant_id: isGranted ? grantId : null,
            granted_by: toPositiveInt(entry.granted_by),
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

/**
 * Loads the department's members with their grant state and the actor's server-resolved capabilities.
 *
 * The hook fetches once on mount and again after every mutation. `memberNameById` is derived from
 * `items` so the provenance column needs no second request and no `services/` import (which a client
 * file must never reach).
 *
 * @returns the canonical `{ items, isLoading, isSubmitting, error, capabilities, memberNameById,
 *          refresh, grant, revoke }` surface.
 */
export function useAssignmentGrants(): UseAssignmentGrantsResult {
    const [items, setItems] = useState<MemberGrantItem[]>([]);
    const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchGrants = useCallback(async (showLoading: boolean): Promise<void> => {
        if (showLoading) setIsLoading(true);
        try {
            const res = await fetch(ENDPOINT, { cache: "no-store" });
            const envelope = await readEnvelope(res);
            if (!res.ok) throw new Error(readMessage(envelope, "Failed to load the assignment grants"));

            setItems(toMemberGrantItems(envelope.data));

            const parsed = CapabilitiesSchema.safeParse(envelope.capabilities);
            setCapabilities(parsed.success ? parsed.data : null);
            setError(null);
        } catch (err: unknown) {
            const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
            setError(message);
            toast.error("Assignment grants unavailable", { description: message });
        } finally {
            if (showLoading) setIsLoading(false);
        }
    }, []);

    const refresh = useCallback(async (): Promise<void> => {
        await fetchGrants(true);
    }, [fetchGrants]);

    /** Fires one write request, reads the envelope, and throws the server message when it failed. */
    const request = useCallback(async (method: HttpMethod, body: unknown): Promise<void> => {
        const res = await fetch(ENDPOINT, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        const envelope = await readEnvelope(res);
        // 200 is the success answer for both writes (a grant may revive an existing row).
        if (!res.ok) throw new Error(readMessage(envelope, "The grant operation could not be completed"));
    }, []);

    /** Every mutation runs through here: act, refetch, toast, and record the persistent error. */
    const runMutation = useCallback(
        async (action: () => Promise<unknown>, successMessage: string): Promise<boolean> => {
            setIsSubmitting(true);
            try {
                await action();
                await fetchGrants(false);
                setError(null);
                toast.success(successMessage);
                return true;
            } catch (err: unknown) {
                const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
                setError(message);
                toast.error("Assignment grants", { description: message });
                return false;
            } finally {
                setIsSubmitting(false);
            }
        },
        [fetchGrants],
    );

    const grant = useCallback(
        async (userId: number, label: string): Promise<boolean> =>
            runMutation(() => request("POST", { user_id: userId }), `${label} can now assign tasks`),
        [request, runMutation],
    );

    const revoke = useCallback(
        async (grantId: number, label: string): Promise<boolean> =>
            runMutation(() => request("DELETE", { id: grantId }), `${label} can no longer assign tasks`),
        [request, runMutation],
    );

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const memberNameById = useMemo<ReadonlyMap<number, string>>(
        () => new Map(items.map((member) => [member.user_id, member.full_name])),
        [items],
    );

    return {
        items,
        isLoading,
        isSubmitting,
        error,
        capabilities,
        memberNameById,
        refresh,
        grant,
        revoke,
    };
}

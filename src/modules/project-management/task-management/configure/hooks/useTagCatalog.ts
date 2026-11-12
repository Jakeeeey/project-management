"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * The department's tag catalog: read it, add to it, rename or recolour a tag, retire one.
 *
 * This hook exists separately from `tasks/hooks/useTags.ts` on purpose. The task surfaces only need
 * the catalog list plus assign/unassign; this page only needs the catalog itself. Splitting them keeps
 * the tag picker from importing a management surface, and keeps the two lanes that own those files
 * from editing one hook.
 *
 * Route contract — `/api/project-management/task-management/configure/tags`:
 * - `GET`    -> 200 `{ success, data: TagRow[] }` (live rows, ordered `sort_order` then `id`).
 * - `POST`   -> 200 `{ success, data: TagRow }`, body `{ label, color, icon, sort_order }`. A label
 *   that was retired earlier is revived by the server rather than inserted again, so a create can
 *   return an existing id.
 * - `PATCH`  -> 200 `{ success, data: TagRow }`, body `{ id, label?, color?, icon? }`.
 * - `DELETE` -> 200 `{ success, data: TagRow }` with `is_deleted: 1`, body `{ id }`.
 *
 * Every write answers 200 rather than 201 for the same reason the assignee route does: a create may
 * revive a retired row, so there is no single "created" answer.
 */

/** The tag catalog route, nested under the Configure feature that owns catalog editing. */
const TAGS_ENDPOINT = "/api/project-management/task-management/configure/tags";

/** The services throw `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

/** One row of the department's tag catalog. */
export interface TagRow {
    readonly id: number;
    readonly label: string;
    readonly color: string | null;
    /**
     * A lucide icon id, or `null` for the default tag glyph.
     *
     * Unlike a status icon this is NOT an allow-listed name: tags accept any lucide id, because the
     * glyph here is decoration for an arbitrary label ("Deployed", "Needs review", …) rather than a
     * fixed lifecycle vocabulary. An id the installed lucide version does not draw renders the
     * fallback glyph instead of throwing.
     */
    readonly icon: string | null;
    readonly sort_order: number;
}

/** What a create or an edit sends: colour and icon are optional, and `null` means "none". */
export interface TagInput {
    readonly label: string;
    readonly color: string | null;
    readonly icon: string | null;
}

export interface UseTagCatalogResult {
    readonly tags: readonly TagRow[];
    readonly isLoading: boolean;
    readonly isSubmitting: boolean;
    readonly error: string | null;
    readonly refresh: () => Promise<void>;
    readonly createTag: (input: TagInput) => Promise<boolean>;
    readonly updateTag: (id: number, input: TagInput) => Promise<boolean>;
    readonly deleteTag: (id: number, label: string) => Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripCode(message: string): string {
    return message.replace(UPPERCASE_CODE_PREFIX, "").trim();
}

/** A wire row, or `null` when any field is unusable — one bad row never breaks the catalog. */
function parseTagRow(value: unknown): TagRow | null {
    if (!isRecord(value)) return null;
    const { id, label, color, icon, sort_order } = value;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
    if (typeof label !== "string" || label.trim() === "") return null;
    const normalisedColor = typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
    const normalisedIcon = typeof icon === "string" && icon.trim() !== "" ? icon.trim() : null;
    return {
        id,
        label,
        color: normalisedColor,
        icon: normalisedIcon,
        sort_order: typeof sort_order === "number" && Number.isFinite(sort_order) ? sort_order : 0,
    };
}

async function readEnvelope(res: Response): Promise<Record<string, unknown>> {
    const payload: unknown = await res.json().catch(() => null);
    return isRecord(payload) ? payload : {};
}

export function useTagCatalog(): UseTagCatalogResult {
    const [tags, setTags] = useState<readonly TagRow[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async (): Promise<void> => {
        setIsLoading(true);
        try {
            const res = await fetch(TAGS_ENDPOINT, { cache: "no-store" });
            const envelope = await readEnvelope(res);
            if (!res.ok) {
                const message = typeof envelope.message === "string" ? stripCode(envelope.message) : "";
                throw new Error(message || "The tags could not be loaded");
            }
            const rows = Array.isArray(envelope.data) ? envelope.data : [];
            setTags(rows.map(parseTagRow).filter((row): row is TagRow => row !== null));
            setError(null);
        } catch (err: unknown) {
            // A missing table while the owner registers the DDL reads as an empty catalog, not a
            // broken page: the section still lets a tag be added once the route answers.
            setError(stripCode(err instanceof Error ? err.message : "The tags could not be loaded"));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    /** One write: act, refetch the catalog, toast, and keep the last failure readable on the page. */
    const runMutation = useCallback(
        async (
            method: "POST" | "PATCH" | "DELETE",
            body: Record<string, unknown>,
            successMessage: string,
            failureTitle: string,
        ): Promise<boolean> => {
            setIsSubmitting(true);
            try {
                const res = await fetch(TAGS_ENDPOINT, {
                    method,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                const envelope = await readEnvelope(res);
                if (!res.ok) {
                    const message = typeof envelope.message === "string" ? stripCode(envelope.message) : "";
                    throw new Error(message || "The change could not be saved");
                }
                await refresh();
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
        [refresh],
    );

    const createTag = useCallback(
        async (input: TagInput): Promise<boolean> =>
            runMutation(
                "POST",
                {
                    label: input.label.trim(),
                    color: input.color,
                    icon: input.icon,
                    // New tags land at the end of the catalog; the server keeps rows ordered anyway.
                    sort_order: tags.reduce((highest, tag) => Math.max(highest, tag.sort_order), 0) + 1,
                },
                `${input.label.trim()} added`,
                "Could not add the tag",
            ),
        [runMutation, tags],
    );

    const updateTag = useCallback(
        async (id: number, input: TagInput): Promise<boolean> =>
            runMutation(
                "PATCH",
                { id, label: input.label.trim(), color: input.color, icon: input.icon },
                `${input.label.trim()} saved`,
                "Could not save the tag",
            ),
        [runMutation],
    );

    const deleteTag = useCallback(
        async (id: number, label: string): Promise<boolean> =>
            runMutation("DELETE", { id }, `${label} removed`, "Could not remove the tag"),
        [runMutation],
    );

    return { tags, isLoading, isSubmitting, error, refresh, createTag, updateTag, deleteTag };
}

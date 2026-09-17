"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { CapabilitiesSchema, type Capabilities } from "@/modules/project-management/types/capabilities";

import { parseTaskFields, type TaskField, type TaskFieldType } from "./useTasks";

/**
 * The client hook behind the Settings → Custom fields builder.
 *
 * One route, one shape: every call goes to `/api/project-management/task-management/configure/fields` with only
 * `Content-Type: application/json` — never an `Authorization` header, because the browser already
 * sends the session cookie and the route resolves the actor from it. Capabilities are READ from the
 * route payload, never computed here: a plain member is told `canConfigure: false` by the server and
 * the builder renders nothing.
 *
 * A column and a choice are different tables with independent id spaces, so every write carries a
 * `kind: "field" | "option"` discriminator alongside the row — a bare id would be ambiguous.
 *
 * Mutation strategy is single and fixed: **refetch after mutate**. There is no optimistic patching
 * anywhere in this module, so the list can never drift from the server's answer.
 */

/** The one endpoint this hook talks to. */
const ENDPOINT = "/api/project-management/task-management/configure/fields";

/** The service throws `CODE: message`; the code prefix never reaches the UI. */
const UPPERCASE_CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

type HttpMethod = "POST" | "PATCH" | "DELETE";

/** The editable fields of one column, as the dialog collects them. */
export interface TaskFieldFormInput {
    readonly label: string;
    readonly field_type: TaskFieldType;
}

/** Reorder direction for the keyboard-accessible up/down controls. */
export type TaskFieldMoveDirection = "up" | "down";

/** The canonical return of the custom-fields builder hook. */
export interface UseTaskFieldsResult {
    /** The department's live columns with their choices, ordered by `(sort_order, id)`. */
    readonly fields: TaskField[];
    readonly isLoading: boolean;
    /** True while one of the mutations below is in flight. */
    readonly isSubmitting: boolean;
    readonly error: string | null;
    /** Server-resolved capabilities; `null` until the first successful load. */
    readonly capabilities: Capabilities | null;
    /** The fetcher alias, standardized on `refresh`. */
    readonly refresh: () => Promise<void>;
    readonly createField: (input: TaskFieldFormInput) => Promise<boolean>;
    readonly renameField: (id: number, label: string) => Promise<boolean>;
    readonly deleteField: (id: number, label: string) => Promise<boolean>;
    readonly setEnabled: (fieldId: number, enabled: boolean) => Promise<boolean>;
    readonly setDefaultValue: (fieldId: number, value: string | null) => Promise<boolean>;
    /** Adds a choice; resolves to the new choice's id, or `null` when the write failed. */
    readonly createOption: (fieldId: number, label: string, color: string | null) => Promise<number | null>;
    readonly renameOption: (optionId: number, label: string) => Promise<boolean>;
    readonly setOptionColor: (optionId: number, color: string | null) => Promise<boolean>;
    readonly deleteOption: (optionId: number, label: string) => Promise<boolean>;
    readonly moveOption: (
        fieldId: number,
        optionId: number,
        direction: TaskFieldMoveDirection,
    ) => Promise<boolean>;
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

/** Human label for a column type, so components never re-derive their own copy. */
export function fieldTypeLabel(type: TaskFieldType): string {
    switch (type) {
        case "text":
            return "Text";
        case "number":
            return "Number";
        case "date":
            return "Date";
        case "select":
            return "Choice";
    }
}

/**
 * Loads the department's custom columns and the actor's capabilities.
 *
 * The hook fetches once on mount and again after every mutation.
 *
 * @returns the canonical `{ fields, isLoading, isSubmitting, error, capabilities, refresh, ... }`
 *          surface.
 */
export function useTaskFields(): UseTaskFieldsResult {
    const [fields, setFields] = useState<TaskField[]>([]);
    const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchFields = useCallback(async (showLoading: boolean): Promise<void> => {
        if (showLoading) setIsLoading(true);
        try {
            const res = await fetch(ENDPOINT, { cache: "no-store" });
            const envelope = await readEnvelope(res);
            if (!res.ok) throw new Error(readMessage(envelope, "Failed to load the custom fields"));

            setFields(parseTaskFields(envelope.data));

            const parsed = CapabilitiesSchema.safeParse(envelope.capabilities);
            setCapabilities(parsed.success ? parsed.data : null);
            setError(null);
        } catch (err: unknown) {
            const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
            setError(message);
            toast.error("Custom fields unavailable", { description: message });
        } finally {
            if (showLoading) setIsLoading(false);
        }
    }, []);

    const refresh = useCallback(async (): Promise<void> => {
        await fetchFields(true);
    }, [fetchFields]);

    /** Fires one request, reads the envelope, and throws the server message when it failed. */
    const request = useCallback(async (method: HttpMethod, body: unknown): Promise<unknown> => {
        const res = await fetch(ENDPOINT, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        const envelope = await readEnvelope(res);
        if (!res.ok) throw new Error(readMessage(envelope, "The custom-field operation could not be completed"));
        return envelope.data;
    }, []);

    /** Every mutation runs through here: act, refetch, toast, and record the persistent error. */
    const runMutation = useCallback(
        async (action: () => Promise<unknown>, successMessage: string): Promise<boolean> => {
            setIsSubmitting(true);
            try {
                await action();
                await fetchFields(false);
                setError(null);
                toast.success(successMessage);
                return true;
            } catch (err: unknown) {
                const message = stripCode(err instanceof Error ? err.message : "An unknown error occurred");
                setError(message);
                toast.error("Custom fields", { description: message });
                return false;
            } finally {
                setIsSubmitting(false);
            }
        },
        [fetchFields],
    );

    const createField = useCallback(
        async (input: TaskFieldFormInput): Promise<boolean> => {
            const sortOrder = fields.reduce((highest, field) => Math.max(highest, field.sort_order), -1) + 1;
            return runMutation(
                () => request("POST", { kind: "field", ...input, sort_order: sortOrder }),
                `${input.label} added`,
            );
        },
        [fields, request, runMutation],
    );

    const renameField = useCallback(
        async (id: number, label: string): Promise<boolean> =>
            runMutation(() => request("PATCH", { kind: "field", id, label }), `${label} updated`),
        [request, runMutation],
    );

    const deleteField = useCallback(
        async (id: number, label: string): Promise<boolean> =>
            runMutation(() => request("DELETE", { kind: "field", id }), `${label} removed`),
        [request, runMutation],
    );

    const setEnabled = useCallback(
        async (fieldId: number, enabled: boolean): Promise<boolean> => {
            const label = fields.find((candidate) => candidate.id === fieldId)?.label ?? "Column";
            return runMutation(
                () => request("PATCH", { kind: "field", id: fieldId, is_enabled: enabled }),
                enabled ? `${label} shown` : `${label} hidden`,
            );
        },
        [fields, request, runMutation],
    );

    const setDefaultValue = useCallback(
        async (fieldId: number, value: string | null): Promise<boolean> =>
            runMutation(
                () => request("PATCH", { kind: "field", id: fieldId, default_value: value }),
                "Default updated",
            ),
        [request, runMutation],
    );

    const createOption = useCallback(
        async (fieldId: number, label: string, color: string | null): Promise<number | null> => {
            const field = fields.find((candidate) => candidate.id === fieldId);
            const sortOrder =
                (field?.options.reduce((highest, option) => Math.max(highest, option.sort_order), -1) ?? -1) + 1;

            let createdId: number | null = null;
            const ok = await runMutation(async () => {
                const data = await request("POST", {
                    kind: "option",
                    field_id: fieldId,
                    label,
                    color,
                    sort_order: sortOrder,
                });
                if (isRecord(data) && typeof data.id === "number") createdId = data.id;
            }, `${label} added as a choice`);

            return ok ? createdId : null;
        },
        [fields, request, runMutation],
    );

    const renameOption = useCallback(
        async (optionId: number, label: string): Promise<boolean> =>
            runMutation(() => request("PATCH", { kind: "option", id: optionId, label }), `${label} updated`),
        [request, runMutation],
    );

    const setOptionColor = useCallback(
        async (optionId: number, color: string | null): Promise<boolean> =>
            runMutation(() => request("PATCH", { kind: "option", id: optionId, color }), "Colour updated"),
        [request, runMutation],
    );

    const deleteOption = useCallback(
        async (optionId: number, label: string): Promise<boolean> =>
            runMutation(() => request("DELETE", { kind: "option", id: optionId }), `${label} removed`),
        [request, runMutation],
    );

    /**
     * Reorders one choice within its column. The column's choices are renumbered with sequential
     * `sort_order` values and only the rows whose position actually changed are written, so a swap of
     * two adjacent choices on an already-sequential list is exactly two writes.
     */
    const moveOption = useCallback(
        async (fieldId: number, optionId: number, direction: TaskFieldMoveDirection): Promise<boolean> => {
            const field = fields.find((candidate) => candidate.id === fieldId);
            if (field === undefined) return false;

            const list = field.options;
            const index = list.findIndex((option) => option.id === optionId);
            const target = direction === "up" ? index - 1 : index + 1;

            if (index < 0 || target < 0 || target >= list.length) return false;

            const reordered = [...list];
            const moved = reordered[index];
            reordered[index] = reordered[target];
            reordered[target] = moved;

            return runMutation(async () => {
                for (let position = 0; position < reordered.length; position += 1) {
                    const option = reordered[position];
                    if (option.sort_order === position) continue;
                    await request("PATCH", { kind: "option", id: option.id, sort_order: position });
                }
            }, "Order updated");
        },
        [fields, request, runMutation],
    );

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return {
        fields,
        isLoading,
        isSubmitting,
        error,
        capabilities,
        refresh,
        createField,
        renameField,
        deleteField,
        setEnabled,
        setDefaultValue,
        createOption,
        renameOption,
        setOptionColor,
        deleteOption,
        moveOption,
    };
}
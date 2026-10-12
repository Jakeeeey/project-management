"use client";

import { useEffect, useState } from "react";

import type { MemberAccessItem } from "./useAccess";

export const GRANT_CANDIDATE_PAGE_SIZE = 20;

const ENDPOINT = "/api/project-management/task-management/access";
const SEARCH_DEBOUNCE_MS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPositiveInt(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readFlag(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
    return false;
}

function fullNameOf(firstName: unknown, lastName: unknown): string {
    const first = typeof firstName === "string" ? firstName.trim() : "";
    const last = typeof lastName === "string" ? lastName.trim() : "";
    return [first, last].filter(Boolean).join(" ");
}

function toItems(raw: unknown): MemberAccessItem[] {
    if (!Array.isArray(raw)) return [];
    const items: MemberAccessItem[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const userId = toPositiveInt(entry.user_id);
        if (userId === null) continue;
        const isGranted = readFlag(entry.is_granted);
        const grantId = toPositiveInt(entry.grant_id);
        const email =
            typeof entry.user_email === "string" && entry.user_email.trim() !== ""
                ? entry.user_email.trim()
                : null;
        items.push({
            user_id: userId,
            full_name: fullNameOf(entry.user_fname, entry.user_lname) || `User #${userId}`,
            user_email: email,
            is_granted: isGranted,
            grant_id: isGranted ? grantId : null,
            granted_by: toPositiveInt(entry.granted_by),
            is_self: readFlag(entry.is_self),
        });
    }
    return items;
}

function toCount(raw: unknown): number {
    if (raw === null || raw === undefined) return 0;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export interface UseGrantCandidatesResult {
    readonly query: string;
    readonly candidates: MemberAccessItem[];
    readonly total: number;
    readonly hasMore: boolean;
    readonly isLoading: boolean;
    readonly setQuery: (value: string) => void;
}

export function useGrantCandidates(open: boolean): UseGrantCandidatesResult {
    const [query, setQueryState] = useState("");
    const [debounced, setDebounced] = useState("");
    const [candidates, setCandidates] = useState<MemberAccessItem[]>([]);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (!open) return;
        const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, open]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const controller = new AbortController();
        async function load(): Promise<void> {
            setIsLoading(true);
            try {
                const params = new URLSearchParams({ page: "1", pageSize: String(GRANT_CANDIDATE_PAGE_SIZE) });
                if (debounced !== "") params.set("q", debounced);
                const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
                    cache: "no-store",
                    signal: controller.signal,
                });
                const payload: unknown = await res.json().catch(() => null);
                if (cancelled || !res.ok || !isRecord(payload)) return;
                const items = toItems(payload.data);
                setCandidates(items.filter((member) => !member.is_granted && !member.is_self));
                const totalCount = toCount(payload.total);
                setTotal(totalCount);
                setHasMore(totalCount > items.length);
            } catch (err: unknown) {
                if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
                    setCandidates([]);
                    setTotal(0);
                    setHasMore(false);
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        }
        void load();
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [open, debounced]);

    useEffect(() => {
        if (!open) {
            setQueryState("");
            setDebounced("");
            setCandidates([]);
            setTotal(0);
            setHasMore(false);
        }
    }, [open]);

    return {
        query,
        candidates,
        total,
        hasMore,
        isLoading,
        setQuery: setQueryState,
    };
}

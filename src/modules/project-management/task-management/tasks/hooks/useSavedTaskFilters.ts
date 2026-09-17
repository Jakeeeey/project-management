"use client";

import { useCallback, useRef, useState } from "react";

import {
    createFilterClauseId,
    readSavedTaskFilters,
    writeSavedTaskFilters,
    type FilterClause,
    type SavedTaskFilter,
} from "../components/task-filter";

/**
 * The per-user saved-filter store, backed by localStorage.
 *
 * The `TasksModule` orchestrator owns this hook and hands the list plus the two write callbacks to
 * the (purely presentational) toolbar, so no component below it ever touches storage.
 *
 * Loading is lazy state so nothing writes state from an effect. The stored list drives only the
 * `Saved filters` popup, which is not part of the initial markup, so reading storage on the client's
 * first render cannot produce a hydration mismatch. A corrupt or absent value degrades to "no saved
 * filters" — `readSavedTaskFilters` already swallows and validates — so a bad localStorage entry can
 * never break the tasks page.
 *
 * A save REPLACES an existing set with the same (case-insensitive) name, so repeatedly saving the
 * same filter does not pile up duplicates.
 */

export interface UseSavedTaskFiltersResult {
    readonly savedFilters: readonly SavedTaskFilter[];
    /** Saves the current clauses under a name; a blank name or an empty set is a no-op. */
    readonly saveFilter: (name: string, clauses: readonly FilterClause[]) => void;
    /** Removes one saved set by id. */
    readonly deleteFilter: (id: string) => void;
}

export function useSavedTaskFilters(): UseSavedTaskFiltersResult {
    const [savedFilters, setSavedFilters] = useState<readonly SavedTaskFilter[]>(() =>
        typeof window === "undefined" ? [] : readSavedTaskFilters(),
    );
    /** Mirrors the state so a handler can compute the next list without a stale closure. */
    const filtersRef = useRef<readonly SavedTaskFilter[]>(savedFilters);

    const commit = useCallback((next: readonly SavedTaskFilter[]): void => {
        filtersRef.current = next;
        setSavedFilters(next);
        writeSavedTaskFilters(next);
    }, []);

    const saveFilter = useCallback(
        (name: string, clauses: readonly FilterClause[]): void => {
            const trimmed = name.trim();
            if (trimmed === "" || clauses.length === 0) return;

            const lower = trimmed.toLowerCase();
            const rest = filtersRef.current.filter((filter) => filter.name.toLowerCase() !== lower);
            commit([
                ...rest,
                {
                    id: createFilterClauseId(),
                    name: trimmed,
                    clauses: clauses.map((clause) => ({ ...clause })),
                },
            ]);
        },
        [commit],
    );

    const deleteFilter = useCallback(
        (id: string): void => {
            commit(filtersRef.current.filter((filter) => filter.id !== id));
        },
        [commit],
    );

    return { savedFilters, saveFilter, deleteFilter };
}

"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
    EMPTY_TASK_FILTER_STATE,
    readTaskFilterState,
    TASK_FILTER_STATE_KEY,
    writeTaskFilterState,
    type TaskFilterState,
} from "../components/task-filter-state";
import { type FilterGroup } from "../components/task-filter";

/**
 * The ONE live filter every task tab reads and writes, backed by localStorage.
 *
 * A module-level store rather than per-view `useState`, for two reasons. Switching tabs unmounts one
 * view and mounts the next, so per-view state would drop the filter on every switch; and the reader
 * expects the rows they narrowed to once to stay narrowed while they compare tabs. The store is
 * shared by the List's toolbar and by each read-only view, so all seven tabs show the same filter and
 * any of them can change it.
 *
 * `useSyncExternalStore` (the same shape as the column-width store) gives React a server snapshot of
 * "no filter" for the first render, then adopts the stored one on the client. Writing that from an
 * effect instead would render every task once, then re-render filtered — a flash of rows the reader
 * already excluded — and would fight the repo's `react-hooks/set-state-in-effect` rule.
 *
 * A storage-denied browser still works: the in-memory copy is the source of truth for the session
 * and the write is simply swallowed.
 */

/** The in-memory source of truth. `null` means "not read yet"; the first client read seeds it. */
let currentState: TaskFilterState | null = null;

/** Every mounted subscriber; the store notifies them when the filter changes. */
const listeners = new Set<() => void>();

function getStateSnapshot(): TaskFilterState {
    if (currentState === null) currentState = readTaskFilterState();
    return currentState;
}

function getServerStateSnapshot(): TaskFilterState {
    return EMPTY_TASK_FILTER_STATE;
}

function notifyStateChanged(): void {
    for (const listener of listeners) listener();
}

function subscribeToState(listener: () => void): () => void {
    listeners.add(listener);

    // An edit in another tab of this browser is the one change this tab did not make itself.
    const onStorage = (event: StorageEvent): void => {
        if (event.key !== null && event.key !== TASK_FILTER_STATE_KEY) return;
        currentState = readTaskFilterState();
        listener();
    };
    window.addEventListener("storage", onStorage);

    return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
    };
}

/** Commits the next state: in memory first (so a denied storage still lasts the session), then disk. */
function commitState(next: TaskFilterState): void {
    currentState = next;
    writeTaskFilterState(next);
    notifyStateChanged();
}

export interface UseTaskFilterStateResult {
    readonly search: string;
    readonly groups: readonly FilterGroup[];
    readonly onSearchChange: (value: string) => void;
    readonly onGroupsChange: (groups: readonly FilterGroup[]) => void;
    /** Resets both the search box and the groups. */
    readonly clearFilters: () => void;
}

export function useTaskFilterState(): UseTaskFilterStateResult {
    const state = useSyncExternalStore(subscribeToState, getStateSnapshot, getServerStateSnapshot);

    const onSearchChange = useCallback((value: string): void => {
        commitState({ ...getStateSnapshot(), search: value });
    }, []);

    const onGroupsChange = useCallback((groups: readonly FilterGroup[]): void => {
        commitState({ ...getStateSnapshot(), groups });
    }, []);

    const clearFilters = useCallback((): void => {
        commitState(EMPTY_TASK_FILTER_STATE);
    }, []);

    return {
        search: state.search,
        groups: state.groups,
        onSearchChange,
        onGroupsChange,
        clearFilters,
    };
}

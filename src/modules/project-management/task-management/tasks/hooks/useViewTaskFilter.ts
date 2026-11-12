"use client";

import { useCallback, useMemo } from "react";

import type { FilterBuilderMember, FilterBuilderOption } from "../components/TaskFilterBuilder";
import {
    anyGroupActive,
    cloneGroupsForApply,
    countActiveClauses,
    rowMatchesFilter,
    type FilterGroup,
} from "../components/task-filter";
import { knownGroups } from "../components/task-filter-state";
import { useSavedTaskFilters } from "./useSavedTaskFilters";
import { useTaskFilterState } from "./useTaskFilterState";
import type { TaskCatalogs, TaskField, TaskListItem } from "./useTasks";

/**
 * The search + group state a read-only view reads, over the rows the shell already fetched.
 *
 * The state is NOT this view's own: `useTaskFilterState` owns one persisted filter for the whole
 * tasks page, so narrowing the Calendar and then switching to Team keeps the same rows narrowed
 * instead of resetting. Nothing in this hook fetches or writes.
 */

interface UseViewTaskFilterArgs {
    readonly items: readonly TaskListItem[];
    readonly fields: readonly TaskField[];
    readonly catalogs: TaskCatalogs;
    readonly memberNameById: ReadonlyMap<number, string>;
}

export interface ViewTaskFilter {
    readonly search: string;
    readonly onSearchChange: (value: string) => void;
    readonly groups: readonly FilterGroup[];
    readonly onGroupsChange: (groups: readonly FilterGroup[]) => void;
    /** Search or any live clause is narrowing the view. */
    readonly isFiltering: boolean;
    /** Resets both the search box and the groups. */
    readonly clearFilters: () => void;
    /** Rows that match, in the order the caller passed them. */
    readonly visibleItems: readonly TaskListItem[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    readonly tags: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    readonly savedFilters: ReturnType<typeof useSavedTaskFilters>["savedFilters"];
    readonly onSaveFilter: ReturnType<typeof useSavedTaskFilters>["saveFilter"];
    readonly onApplySavedFilter: (filter: { readonly id: string; readonly groups: readonly FilterGroup[] }) => void;
    readonly onDeleteSavedFilter: ReturnType<typeof useSavedTaskFilters>["deleteFilter"];
}

export function useViewTaskFilter({
    items,
    fields,
    catalogs,
    memberNameById,
}: UseViewTaskFilterArgs): ViewTaskFilter {
    const { search, groups, onSearchChange, onGroupsChange, clearFilters } = useTaskFilterState();
    const { savedFilters, saveFilter, deleteFilter } = useSavedTaskFilters();

    /**
     * A persisted custom-column clause outlives the column. Matching with only the clauses this
     * department still has keeps a deleted field from reading as "no tasks at all"; the builder
     * still shows the stale row so the reader can see and remove it.
     */
    const fieldIds = useMemo<ReadonlySet<number>>(() => new Set(fields.map((field) => field.id)), [fields]);
    const appliedGroups = useMemo(() => knownGroups(groups, fieldIds), [groups, fieldIds]);

    const term = search.trim().toLowerCase();
    const isFiltering = term !== "" || anyGroupActive(appliedGroups);

    const visibleItems = useMemo(() => {
        if (!isFiltering) return items;
        return items.filter((row) => {
            if (term !== "" && !row.title.toLowerCase().includes(term)) return false;
            return rowMatchesFilter(row, appliedGroups, fields);
        });
    }, [items, isFiltering, term, appliedGroups, fields]);

    const statuses = useMemo<FilterBuilderOption[]>(
        () =>
            catalogs.statuses.map((option) => ({
                id: option.id,
                label: option.label,
                color: option.color,
                icon: option.icon,
            })),
        [catalogs.statuses],
    );

    const priorities = useMemo<FilterBuilderOption[]>(
        () =>
            catalogs.priorities.map((option) => ({
                id: option.id,
                label: option.label,
                color: option.color,
                icon: option.icon,
            })),
        [catalogs.priorities],
    );

    const tags = useMemo<FilterBuilderOption[]>(
        () =>
            catalogs.tags.map((tag) => ({
                id: tag.id,
                label: tag.label,
                color: tag.color,
                icon: tag.icon,
            })),
        [catalogs.tags],
    );

    // The directory only names members; the row order is the shell's, so ids stay stable.
    const members = useMemo<FilterBuilderMember[]>(
        () =>
            [...memberNameById.entries()]
                .map(([userId, name]) => ({ user_id: userId, full_name: name }))
                .sort((a, b) => a.full_name.localeCompare(b.full_name, undefined, { sensitivity: "base" })),
        [memberNameById],
    );

    const onApplySavedFilter = useCallback(
        (filter: { readonly groups: readonly FilterGroup[] }) => {
            onGroupsChange(cloneGroupsForApply(filter.groups));
        },
        [onGroupsChange],
    );

    return {
        search,
        onSearchChange,
        groups,
        onGroupsChange,
        isFiltering,
        clearFilters,
        visibleItems,
        statuses,
        priorities,
        tags,
        members,
        savedFilters,
        onSaveFilter: saveFilter,
        onApplySavedFilter,
        onDeleteSavedFilter: deleteFilter,
    };
}

/** How many filled-in clauses a filter trigger counts, across every group. */
export function activeClauseCount(groups: readonly FilterGroup[]): number {
    return countActiveClauses(groups);
}

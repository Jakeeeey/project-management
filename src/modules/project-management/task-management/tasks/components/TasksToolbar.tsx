"use client";

import { useMemo } from "react";
import { RotateCcw, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
    TaskCombobox,
    type TaskComboboxOption,
} from "@/modules/project-management/components/TaskCombobox";

import { TaskFieldFilter, type FieldFilterClause } from "./TaskFieldFilter";
import type { TaskField } from "../hooks/useTasks";

/**
 * The tasks filter bar: search, the catalog-driven filters, and the list controls.
 *
 * Purely presentational and fully controlled — every value and every handler is a prop, so the
 * orchestrator owns the filter and pagination state and this file never fetches or derives anything.
 *
 * The page-level ACTIONS deliberately do not live here. They belong beside the page title (see
 * `TasksHeaderActions`), which is what keeps this bar a single, readable row of list controls
 * instead of eight competing ones. Filter options are DATA: statuses and priorities come from the
 * department's catalogs and members from the access directory, so nothing here hardcodes a status,
 * priority or person.
 *
 * Every control is the primitive's DEFAULT size (`h-9`), so the search field, the three comboboxes
 * and the two buttons share one baseline. Mixing sizes here is what previously left the row visibly
 * misaligned.
 *
 * The three catalog filters are searchable `TaskCombobox`es because their option sets come from
 * database tables and grow with the department; each carries its own clear (X), so "all statuses"
 * is a real control state rather than a sentinel list row.
 */

/** The catalog option shape the toolbar renders; a `TaskCatalogOption` satisfies it structurally. */
export interface TasksToolbarCatalogOption {
    readonly id: number;
    readonly label: string;
    readonly color: string | null;
}

/** The member option shape the toolbar renders; a `MemberAccessItem` satisfies it structurally. */
export interface TasksToolbarMember {
    readonly user_id: number;
    readonly full_name: string;
}

export interface TasksToolbarProps {
    readonly searchValue: string;
    readonly onSearchChange: (value: string) => void;
    readonly statusFilter: number | null;
    readonly onStatusFilterChange: (value: number | null) => void;
    readonly priorityFilter: number | null;
    readonly onPriorityFilterChange: (value: number | null) => void;
    readonly assigneeFilter: number | null;
    readonly onAssigneeFilterChange: (value: number | null) => void;
    /** The "filter by field" clause: a column key plus the value to match. */
    readonly fieldFilter: FieldFilterClause;
    readonly onFieldFilterChange: (next: FieldFilterClause) => void;
    /** The department's enabled custom columns — the clause's only source of fields. */
    readonly fields: readonly TaskField[];
    /** The department's live statuses — the filter's only source of options. */
    readonly statuses: readonly TasksToolbarCatalogOption[];
    /** The department's live priorities — the filter's only source of options. */
    readonly priorities: readonly TasksToolbarCatalogOption[];
    /** The department's live members. */
    readonly members: readonly TasksToolbarMember[];
    /** The signed-in user id, used only to mark their own row in the assignee filter. */
    readonly currentUserId: number | null;
    /** True when a search term or any filter is active. */
    readonly isFiltering: boolean;
    readonly onClearFilters: () => void;
    /** True while the list is refetching behind the current rows. */
    readonly isRefreshing: boolean;
    readonly onRefresh: () => void;
}

/** A catalog id filter as the combobox's string value, or `null` when unset. */
function filterValue(value: number | null): string | null {
    return value === null ? null : String(value);
}

/** A combobox value back to a number filter; `null` and anything non-numeric clear the filter. */
function parseFilterValue(value: string | null): number | null {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function TasksToolbar({
    searchValue,
    onSearchChange,
    statusFilter,
    onStatusFilterChange,
    priorityFilter,
    onPriorityFilterChange,
    assigneeFilter,
    onAssigneeFilterChange,
    fieldFilter,
    onFieldFilterChange,
    fields,
    statuses,
    priorities,
    members,
    currentUserId,
    isFiltering,
    onClearFilters,
    isRefreshing,
    onRefresh,
}: TasksToolbarProps) {
    // Stable option identities: a new array every render would make the combobox re-register its
    // items and drop an in-progress search, so each catalog is mapped once per source change.
    const statusOptions = useMemo<TaskComboboxOption[]>(
        () => statuses.map((option) => ({ value: String(option.id), label: option.label, color: option.color })),
        [statuses],
    );
    const priorityOptions = useMemo<TaskComboboxOption[]>(
        () => priorities.map((option) => ({ value: String(option.id), label: option.label, color: option.color })),
        [priorities],
    );
    const assigneeOptions = useMemo<TaskComboboxOption[]>(
        () =>
            members.map((member) => ({
                value: String(member.user_id),
                label:
                    member.user_id === currentUserId
                        ? `${member.full_name} (you)`
                        : member.full_name,
            })),
        [members, currentUserId],
    );

    return (
        <div
            data-slot="tasks-toolbar"
            className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-3 shadow-sm lg:flex-row lg:items-center"
        >
            <div className="relative min-w-0 lg:max-w-md lg:flex-1">
                <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                />
                <Input
                    type="search"
                    value={searchValue}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder="Search tasks by title"
                    aria-label="Search tasks by title"
                    className="pl-8"
                />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex lg:shrink-0 lg:items-center">
                <TaskCombobox
                    ariaLabel="Filter by status"
                    placeholder="All statuses"
                    searchPlaceholder="Search statuses..."
                    className="w-full lg:w-40"
                    options={statusOptions}
                    value={filterValue(statusFilter)}
                    onValueChange={(next) => onStatusFilterChange(parseFilterValue(next))}
                />

                <TaskCombobox
                    ariaLabel="Filter by priority"
                    placeholder="All priorities"
                    searchPlaceholder="Search priorities..."
                    className="w-full lg:w-40"
                    options={priorityOptions}
                    value={filterValue(priorityFilter)}
                    onValueChange={(next) => onPriorityFilterChange(parseFilterValue(next))}
                />

                <TaskCombobox
                    ariaLabel="Filter by assignee"
                    placeholder="Anyone"
                    searchPlaceholder="Search members..."
                    className="w-full lg:w-44"
                    options={assigneeOptions}
                    value={filterValue(assigneeFilter)}
                    onValueChange={(next) => onAssigneeFilterChange(parseFilterValue(next))}
                />
            </div>

            <TaskFieldFilter
                clause={fieldFilter}
                onClauseChange={onFieldFilterChange}
                fields={fields}
                statuses={statuses}
                priorities={priorities}
            />

            <div className="flex items-center gap-2 lg:ml-auto">
                {isFiltering ? (
                    <Button type="button" variant="ghost" onClick={onClearFilters}>
                        <X className="size-4" aria-hidden="true" />
                        Clear
                    </Button>
                ) : null}

                <Button
                    type="button"
                    variant="outline"
                    onClick={onRefresh}
                    disabled={isRefreshing}
                    aria-label="Refresh tasks"
                    title="Refresh tasks"
                >
                    {isRefreshing ? (
                        <Spinner className="size-4" />
                    ) : (
                        <RotateCcw className="size-4" aria-hidden="true" />
                    )}
                    Refresh
                </Button>
            </div>
        </div>
    );
}
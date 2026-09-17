"use client";

import { RotateCcw, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { CatalogChipDot } from "@/modules/project-management/components/CatalogChip";

/**
 * The tasks filter bar: search, the catalog-driven filters, and the list controls.
 *
 * Purely presentational and fully controlled — every value and every handler is a prop, so the
 * orchestrator owns the filter and pagination state and this file never fetches or derives anything.
 *
 * The page-level ACTIONS deliberately do not live here. They belong beside the page title (see
 * `TasksHeaderActions`), which is what keeps this bar a single, readable row of list controls
 * instead of eight competing ones. Filter options are DATA: statuses and priorities come from the
 * department's catalogs and members from the grants directory, so nothing here hardcodes a status,
 * priority or person.
 *
 * Every control is the primitive's DEFAULT size (`h-9`), so the search field, the three selects and
 * the two buttons share one baseline. Mixing sizes here is what previously left the row visibly
 * misaligned.
 */

/** Radix `SelectItem` cannot carry an empty value, so "no filter" has an explicit sentinel. */
const ALL_VALUE = "__all__";

/** The catalog option shape the toolbar renders; a `TaskCatalogOption` satisfies it structurally. */
export interface TasksToolbarCatalogOption {
    readonly id: number;
    readonly label: string;
    readonly color: string | null;
}

/** The member option shape the toolbar renders; a `MemberGrantItem` satisfies it structurally. */
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

/** A number filter as the string a `Select` needs, or the "all" sentinel when unset. */
function filterValue(value: number | null): string {
    return value === null ? ALL_VALUE : String(value);
}

/** A `Select` value back to a number filter; the sentinel and anything non-numeric clear the filter. */
function parseFilterValue(value: string): number | null {
    if (value === ALL_VALUE) return null;
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
    statuses,
    priorities,
    members,
    currentUserId,
    isFiltering,
    onClearFilters,
    isRefreshing,
    onRefresh,
}: TasksToolbarProps) {
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
                <Select value={filterValue(statusFilter)} onValueChange={(value) => onStatusFilterChange(parseFilterValue(value))}>
                    <SelectTrigger className="w-full lg:w-40" aria-label="Filter by status">
                        <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                        <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
                        {statuses.map((option) => (
                            <SelectItem key={option.id} value={String(option.id)}>
                                <CatalogChipDot color={option.color} density="comfortable" />
                                <span className="min-w-0 truncate">{option.label}</span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Select value={filterValue(priorityFilter)} onValueChange={(value) => onPriorityFilterChange(parseFilterValue(value))}>
                    <SelectTrigger className="w-full lg:w-40" aria-label="Filter by priority">
                        <SelectValue placeholder="All priorities" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                        <SelectItem value={ALL_VALUE}>All priorities</SelectItem>
                        {priorities.map((option) => (
                            <SelectItem key={option.id} value={String(option.id)}>
                                <CatalogChipDot color={option.color} density="comfortable" />
                                <span className="min-w-0 truncate">{option.label}</span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Select value={filterValue(assigneeFilter)} onValueChange={(value) => onAssigneeFilterChange(parseFilterValue(value))}>
                    <SelectTrigger className="w-full lg:w-44" aria-label="Filter by assignee">
                        <SelectValue placeholder="Anyone" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                        <SelectItem value={ALL_VALUE}>Anyone</SelectItem>
                        {members.map((member) => (
                            <SelectItem key={member.user_id} value={String(member.user_id)}>
                                {member.user_id === currentUserId
                                    ? `${member.full_name} (you)`
                                    : member.full_name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

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
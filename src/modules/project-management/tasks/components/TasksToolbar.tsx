"use client";

import Link from "next/link";
import { Plus, RotateCcw, Search, Settings2, ShieldCheck, X } from "lucide-react";

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
import type { Capabilities } from "@/modules/project-management/types/capabilities";

/**
 * The tasks toolbar: search, the catalog-driven filters, and the primary actions.
 *
 * Purely presentational and fully controlled — every value and every handler is a prop, so the
 * orchestrator owns the filter and pagination state and this file never fetches or derives anything.
 *
 * The three action affordances are gated on the SERVER-resolved `capabilities` object:
 * `canCreate` mounts the primary "New task" action, `canConfigure` links to the department's status
 * and priority catalog, and `canGrant` links to the assignment-grants page. A capability that is
 * `false` (or not yet loaded) leaves the control out of the DOM entirely — no client-side role
 * check, no session inspection, no user-id comparison decides what is shown.
 *
 * Filter options are DATA: statuses and priorities come from the department's catalogs and members
 * from the grants directory, so nothing here hardcodes a status, priority or person.
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
    /** Server-resolved capabilities; the ONLY thing the action gates read. */
    readonly capabilities: Capabilities | null;
    readonly onCreateTask: () => void;
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
    capabilities,
    onCreateTask,
}: TasksToolbarProps) {
    const canCreate = capabilities?.canCreate === true;
    const canConfigure = capabilities?.canConfigure === true;
    const canGrant = capabilities?.canGrant === true;

    return (
        <div
            data-slot="tasks-toolbar"
            className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between"
        >
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative min-w-0 sm:max-w-xs sm:flex-1">
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

                <Select value={filterValue(statusFilter)} onValueChange={(value) => onStatusFilterChange(parseFilterValue(value))}>
                    <SelectTrigger className="w-full sm:w-[170px]" aria-label="Filter by status">
                        <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                        <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
                        {statuses.map((option) => (
                            <SelectItem key={option.id} value={String(option.id)}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Select value={filterValue(priorityFilter)} onValueChange={(value) => onPriorityFilterChange(parseFilterValue(value))}>
                    <SelectTrigger className="w-full sm:w-[170px]" aria-label="Filter by priority">
                        <SelectValue placeholder="All priorities" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                        <SelectItem value={ALL_VALUE}>All priorities</SelectItem>
                        {priorities.map((option) => (
                            <SelectItem key={option.id} value={String(option.id)}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Select value={filterValue(assigneeFilter)} onValueChange={(value) => onAssigneeFilterChange(parseFilterValue(value))}>
                    <SelectTrigger className="w-full sm:w-[190px]" aria-label="Filter by assignee">
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

                {isFiltering ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onClearFilters}
                        className="min-h-11 md:min-h-0"
                    >
                        <X className="size-4" aria-hidden="true" />
                        Clear
                    </Button>
                ) : null}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onRefresh}
                    disabled={isRefreshing}
                    aria-label="Refresh tasks"
                    title="Refresh tasks"
                    className="min-h-11 md:min-h-0"
                >
                    {isRefreshing ? (
                        <Spinner className="size-4" />
                    ) : (
                        <RotateCcw className="size-4" aria-hidden="true" />
                    )}
                    <span className="hidden sm:inline">Refresh</span>
                </Button>

                {canConfigure ? (
                    <Button asChild variant="outline" size="sm" className="min-h-11 md:min-h-0">
                        <Link href="/project-management/settings">
                            <Settings2 className="size-4" aria-hidden="true" />
                            <span className="hidden sm:inline">Statuses and priorities</span>
                        </Link>
                    </Button>
                ) : null}

                {canGrant ? (
                    <Button asChild variant="outline" size="sm" className="min-h-11 md:min-h-0">
                        <Link href="/project-management/assignment-grants">
                            <ShieldCheck className="size-4" aria-hidden="true" />
                            <span className="hidden sm:inline">Manage assigners</span>
                        </Link>
                    </Button>
                ) : null}

                {canCreate ? (
                    <Button type="button" size="sm" onClick={onCreateTask} className="min-h-11 md:min-h-0">
                        <Plus className="size-4" aria-hidden="true" />
                        New task
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

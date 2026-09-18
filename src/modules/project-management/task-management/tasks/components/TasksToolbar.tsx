"use client";

import { useState } from "react";
import { ChevronDown, ListFilter, ListTree, RotateCcw, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import {
    TaskFilterBuilder,
    type FilterBuilderMember,
    type FilterBuilderOption,
} from "./TaskFilterBuilder";
import { isClauseActive, type FilterClause, type SavedTaskFilter } from "./task-filter";
import type { TaskField } from "../hooks/useTasks";

/**
 * The tasks toolbar: the search box, the list controls, and the filter trigger.
 *
 * Purely presentational and fully controlled — every value and every handler is a prop, so the
 * orchestrator owns the search term, the clause array, the saved sets and the pagination state and
 * this file never fetches, stores or derives anything. The ONE piece of state it owns is the
 * filter modal's open flag, which is purely local UI.
 *
 * The page-level ACTIONS deliberately do not live here. They belong beside the page title (see
 * `TasksHeaderActions`), which is what keeps this bar a single, readable row of list controls.
 * Filter options are DATA: statuses and priorities come from the department's catalogs and members
 * from the access directory, so nothing here hardcodes a status, priority or person.
 *
 * The builder is NOT rendered inline any more — it lives inside a `Filters` modal opened by a compact
 * pill that carries the active-clause count. That is what keeps the toolbar one row however many
 * filter rows the user adds; the pill itself is the module's `outline` button with `className`
 * overrides, never a new primitive.
 *
 * Beside the filter pill sits the `Subtasks` control — a dropdown over the pinned two-value enum
 * (Collapsed / Expanded) that drives the tree's own expand/collapse state. It is a MODE, not a
 * one-shot command: the caller derives the active option from the live `expandedIds` set rather than
 * storing a parallel flag, so a hand-collapsed row immediately reads as `Collapsed` again and the
 * checkmark can never disagree with the list. This file stays presentational: it renders the mode it
 * is handed and reports the pick.
 */

/** The member shape the toolbar renders; a `MemberAccessItem` satisfies it structurally. */
export interface TasksToolbarMember {
    readonly user_id: number;
    readonly full_name: string;
}

export interface TasksToolbarProps {
    readonly searchValue: string;
    readonly onSearchChange: (value: string) => void;
    /** The active filter clauses, in order. */
    readonly clauses: readonly FilterClause[];
    readonly onClausesChange: (next: readonly FilterClause[]) => void;
    /** The department's enabled custom columns — the builder's only source of fields. */
    readonly fields: readonly TaskField[];
    /** The department's live statuses — a value control's source of options. */
    readonly statuses: readonly FilterBuilderOption[];
    /** The department's live priorities — a value control's source of options. */
    readonly priorities: readonly FilterBuilderOption[];
    /** The department's live members. */
    readonly members: readonly FilterBuilderMember[];
    /** The signed-in user id, used only to mark their own row in the assignee value control. */
    readonly currentUserId: number | null;
    readonly savedFilters: readonly SavedTaskFilter[];
    readonly onSaveFilter: (name: string, clauses: readonly FilterClause[]) => void;
    readonly onApplySavedFilter: (filter: SavedTaskFilter) => void;
    readonly onDeleteSavedFilter: (id: string) => void;
    /** True when a search term or any clause is active. */
    readonly isFiltering: boolean;
    readonly onClearFilters: () => void;
    /** True while the list is refetching behind the current rows. */
    readonly isRefreshing: boolean;
    readonly onRefresh: () => void;
    /**
     * True when EVERY expandable row is currently expanded — the derived `Expanded` mode of the
     * `Subtasks` control. The caller derives it from the tree's live expansion set, so a row
     * collapsed by hand flips it back to `false` (Collapsed) with no parallel source of truth.
     */
    readonly isSubtasksExpanded: boolean;
    /** Pick `Expanded` (`true`) or `Collapsed` (`false`) for the whole tree. */
    readonly onSubtasksExpandedChange: (expanded: boolean) => void;
}

export function TasksToolbar({
    searchValue,
    onSearchChange,
    clauses,
    onClausesChange,
    fields,
    statuses,
    priorities,
    members,
    currentUserId,
    savedFilters,
    onSaveFilter,
    onApplySavedFilter,
    onDeleteSavedFilter,
    isFiltering,
    onClearFilters,
    isRefreshing,
    onRefresh,
    isSubtasksExpanded,
    onSubtasksExpandedChange,
}: TasksToolbarProps) {
    const [isFilterOpen, setIsFilterOpen] = useState(false);

    /**
     * The pill's count is the number of clauses that ACTUALLY filter, using the same `isClauseActive`
     * predicate the tree's matcher uses — a second definition of "active" would let the badge
     * disagree with the list. Zero reads `Filters` (never `0 Filters`).
     */
    const activeFilterCount = clauses.filter(isClauseActive).length;
    const filterLabel =
        activeFilterCount === 0
            ? "Filters"
            : activeFilterCount === 1
              ? "1 Filter"
              : `${activeFilterCount} Filters`;
    const filterAriaLabel =
        activeFilterCount === 0 ? "Filters, none active" : `Filters, ${activeFilterCount} active`;

    /**
     * The `Subtasks` control's current mode, named from the same boolean the caller derived off the
     * live expansion set — so the trigger, the checkmark and the tree can never disagree.
     */
    const subtasksModeLabel = isSubtasksExpanded ? "Expanded" : "Collapsed";
    const subtasksAriaLabel = `Show subtasks, currently ${subtasksModeLabel}`;

    return (
        <div data-slot="tasks-toolbar" className="space-y-3">
            <div className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-3 shadow-sm sm:flex-row sm:items-center">
                <div className="relative min-w-0 sm:max-w-md sm:flex-1">
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

                <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                    <Dialog open={isFilterOpen} onOpenChange={setIsFilterOpen}>
                        <DialogTrigger asChild>
                            <Button
                                type="button"
                                variant="outline"
                                data-slot="task-filter-trigger"
                                aria-label={filterAriaLabel}
                                title={filterAriaLabel}
                                className={cn(
                                    "rounded-full",
                                    activeFilterCount > 0 &&
                                        "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25",
                                )}
                            >
                                <ListFilter className="size-4" aria-hidden="true" />
                                {filterLabel}
                            </Button>
                        </DialogTrigger>

                        {/*
                         * The filter modal is the widest dialog in the module: four tracks (field /
                         * operator / value / remove) plus the saved-filter controls need real room,
                         * and the operator track in particular must never squeeze "Is not empty" onto
                         * two lines. `w-[95vw]` keeps it inside a phone viewport and the `sm:` tier
                         * caps it on a desktop, matching the module's other dialogs.
                         */}
                        <DialogContent className="w-[95vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[720px]">
                            <DialogHeader className="border-b px-6 pt-6 pb-4">
                                <DialogTitle>Filters</DialogTitle>
                                <DialogDescription>Add rows to narrow the list of tasks.</DialogDescription>
                            </DialogHeader>

                            {/*
                             * The body is the ONLY scrolling region: the builder can grow with several
                             * clauses plus the saved-filters list, so a long set scrolls here while the
                             * header and footer stay pinned.
                             */}
                            <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
                                <TaskFilterBuilder
                                    clauses={clauses}
                                    onClausesChange={onClausesChange}
                                    fields={fields}
                                    statuses={statuses}
                                    priorities={priorities}
                                    members={members}
                                    currentUserId={currentUserId}
                                    savedFilters={savedFilters}
                                    onSaveFilter={onSaveFilter}
                                    onApplySavedFilter={onApplySavedFilter}
                                    onDeleteSavedFilter={onDeleteSavedFilter}
                                />
                            </div>

                            <DialogFooter className="justify-end border-t bg-muted/20 px-6 py-4">
                                {/*
                                 * Resets the CLAUSE SET only — `[]` is exactly the state the module
                                 * starts from and the matcher already treats as "no filters". It
                                 * deliberately does NOT touch the search box: a saved filter's
                                 * `search` text is not part of its clause set (see `task-filter.ts`),
                                 * so the search term stays where the user left it. Low-emphasis ghost
                                 * so the modal's only filled-ish action stays `Done`.
                                 */}
                                <Button
                                    type="button"
                                    variant="ghost"
                                    data-slot="task-filter-clear-all"
                                    onClick={() => onClausesChange([])}
                                    disabled={clauses.length === 0}
                                >
                                    Clear all filters
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setIsFilterOpen(false)}
                                >
                                    Done
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                variant="outline"
                                data-slot="task-subtasks-trigger"
                                aria-label={subtasksAriaLabel}
                                title={subtasksAriaLabel}
                                aria-haspopup="menu"
                                className="rounded-full"
                            >
                                <ListTree className="size-4" aria-hidden="true" />
                                Subtasks
                                <ChevronDown className="size-4" aria-hidden="true" />
                            </Button>
                        </DropdownMenuTrigger>

                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuLabel>Show subtasks</DropdownMenuLabel>
                            <DropdownMenuSeparator />

                            <DropdownMenuCheckboxItem
                                checked={!isSubtasksExpanded}
                                onSelect={() => onSubtasksExpandedChange(false)}
                                aria-label="Show subtasks: Collapsed"
                            >
                                Collapsed
                                <span className="ml-auto text-xs text-muted-foreground">
                                    (default)
                                </span>
                            </DropdownMenuCheckboxItem>

                            <DropdownMenuCheckboxItem
                                checked={isSubtasksExpanded}
                                onSelect={() => onSubtasksExpandedChange(true)}
                                aria-label="Show subtasks: Expanded"
                            >
                                Expanded
                            </DropdownMenuCheckboxItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

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
        </div>
    );
}

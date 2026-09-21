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
 * Fully controlled toolbar — the orchestrator owns search, clauses, saved sets and
 * pagination; only the filter modal's open flag is local.
 * Scope/list-switcher and page actions live in the title row, not here.
 * Filter options are DATA (catalogs + access directory), never hardcoded.
 * The builder lives in a modal so the bar stays one row; the Subtasks control is a
 * MODE derived from the live `expandedIds` set, so the checkmark can't disagree.
 */

export interface TasksToolbarProps {
    readonly searchValue: string;
    readonly onSearchChange: (value: string) => void;
    readonly clauses: readonly FilterClause[];
    readonly onClausesChange: (next: readonly FilterClause[]) => void;
    readonly fields: readonly TaskField[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    readonly currentUserId: number | null;
    readonly savedFilters: readonly SavedTaskFilter[];
    readonly onSaveFilter: (name: string, clauses: readonly FilterClause[]) => void;
    readonly onApplySavedFilter: (filter: SavedTaskFilter) => void;
    readonly onDeleteSavedFilter: (id: string) => void;
    readonly isFiltering: boolean;
    readonly onClearFilters: () => void;
    readonly isRefreshing: boolean;
    readonly onRefresh: () => void;
    /**
     * True when EVERY expandable row is currently expanded — the derived `Expanded` mode of the
     * `Subtasks` control. The caller derives it from the tree's live expansion set, so a row
     * collapsed by hand flips it back to `false` (Collapsed) with no parallel source of truth.
     */
    readonly isSubtasksExpanded: boolean;
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

    // Count with the matcher's own `isClauseActive` so the badge can't disagree with the list.
    const activeFilterCount = clauses.filter(isClauseActive).length;
    let filterLabel = `${activeFilterCount} Filters`;
    if (activeFilterCount === 0) {
        filterLabel = "Filters";
    } else if (activeFilterCount === 1) {
        filterLabel = "1 Filter";
    }
    const filterAriaLabel =
        activeFilterCount === 0 ? "Filters, none active" : `Filters, ${activeFilterCount} active`;

    // Mode comes from the caller's live expansion set, so trigger, checkmark and tree agree.
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

                        {/* Widest dialog in the module: the operator track must never wrap "Is not empty". */}
                        <DialogContent className="w-[95vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[720px]">
                            <DialogHeader className="border-b px-6 pt-6 pb-4">
                                <DialogTitle>Filters</DialogTitle>
                                <DialogDescription>Add rows to narrow the list of tasks.</DialogDescription>
                            </DialogHeader>

                            {/* Only the body scrolls, so the header and footer stay pinned. */}
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
                                {/* Resets clauses only, not the search box; ghost so `Done` stays primary. */}
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

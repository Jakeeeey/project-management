"use client";

import { useState } from "react";
import { ListFilter, Search, X } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
    TaskFilterBuilder,
    type FilterBuilderMember,
    type FilterBuilderOption,
} from "./TaskFilterBuilder";
import { isClauseActive, type FilterClause, type SavedTaskFilter } from "./task-filter";
import type { TaskField } from "../hooks/useTasks";

/**
 * The module's ONE filter toolbar: a search box, the `Filters` trigger with its live count, a
 * `Clear` affordance while anything is applied, and the builder dialog behind the trigger.
 *
 * It exists because five views need the same control and previously only two had one: the List and
 * the Progress tab. Calendar, Team and Dashboard now render this instead of inventing a second
 * pattern, so a clause means exactly the same thing everywhere and the saved-filter sets are
 * shared.
 *
 * Filtering is CLIENT-SIDE and per view: each caller holds its own `clauses` and applies
 * `rowMatchesClauses` to the rows it is about to draw. Two rules follow from that and are the
 * caller's responsibility, not this component's:
 * - a view that prints NUMBERS must decide whether the filter narrows them (Dashboard: yes, the
 *   totals describe the filtered set) or must not move them (Progress: no, a percentage covers every
 *   task whether it is filtered out or not);
 * - the search box is a separate, equally local term — `Clear` resets both, which is why the caller
 *   passes `onClear` rather than this component reaching for state it does not own.
 */
export interface TaskFilterControlProps {
    readonly clauses: readonly FilterClause[];
    readonly onClausesChange: (next: readonly FilterClause[]) => void;
    readonly fields: readonly TaskField[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    readonly tags: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    readonly currentUserId: number | null;
    readonly savedFilters: readonly SavedTaskFilter[];
    readonly onSaveFilter: (name: string, clauses: readonly FilterClause[]) => void;
    readonly onApplySavedFilter: (filter: SavedTaskFilter) => void;
    readonly onDeleteSavedFilter: (id: string) => void;
    /** Omitted when a view has its own search elsewhere; given, the box is drawn in this bar. */
    readonly searchValue?: string;
    readonly onSearchChange?: (value: string) => void;
    readonly searchPlaceholder?: string;
    /** Clears search AND clauses — only rendered while `isFiltering`. */
    readonly isFiltering: boolean;
    readonly onClear: () => void;
    readonly className?: string;
    /**
     * `true` (default) draws the bar's own rounded card, for a view that has no toolbar yet.
     * `false` renders the bare inline group, for a caller that already owns the row — the List
     * toolbar puts it beside its own Subtasks and Refresh buttons.
     */
    readonly chrome?: boolean;
}

export function TaskFilterControl({
    clauses,
    onClausesChange,
    fields,
    statuses,
    priorities,
    tags,
    members,
    currentUserId,
    savedFilters,
    onSaveFilter,
    onApplySavedFilter,
    onDeleteSavedFilter,
    searchValue,
    onSearchChange,
    searchPlaceholder = "Search tasks by title",
    isFiltering,
    onClear,
    className,
    chrome = true,
}: TaskFilterControlProps) {
    const [isFilterOpen, setIsFilterOpen] = useState(false);

    // Count with the matcher's own `isClauseActive` so the badge can't disagree with the rows.
    const activeFilterCount = clauses.filter(isClauseActive).length;
    let filterLabel = `${activeFilterCount} Filters`;
    if (activeFilterCount === 0) {
        filterLabel = "Filters";
    } else if (activeFilterCount === 1) {
        filterLabel = "1 Filter";
    }
    const filterAriaLabel =
        activeFilterCount === 0 ? "Filters, none active" : `Filters, ${activeFilterCount} active`;

    const hasSearch = searchValue !== undefined && onSearchChange !== undefined;

    const body = (
        <>
            {hasSearch ? (
                <div className="relative min-w-0 sm:max-w-md sm:flex-1">
                    <Search
                        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <Input
                        type="search"
                        value={searchValue}
                        onChange={(event) => onSearchChange(event.target.value)}
                        placeholder={searchPlaceholder}
                        aria-label={searchPlaceholder}
                        className="pl-8"
                    />
                </div>
            ) : null}

            <div className={cn("flex flex-wrap items-center gap-2", chrome && "sm:ml-auto")}>
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
                                tags={tags}
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

                {isFiltering ? (
                    <Button type="button" variant="ghost" onClick={onClear}>
                        <X className="size-4" aria-hidden="true" />
                        Clear
                    </Button>
                ) : null}
            </div>
        </>
    );

    if (!chrome) return body;

    return (
        <div
            data-slot="task-filter-bar"
            className={cn(
                "flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-3 shadow-sm sm:flex-row sm:items-center",
                className,
            )}
        >
            {body}
        </div>
    );
}

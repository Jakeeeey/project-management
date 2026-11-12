"use client";

import { ChevronDown, ListTree, RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
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

import type { FilterBuilderMember, FilterBuilderOption } from "./TaskFilterBuilder";
import { FILTER_BAR_ITEM_CLASS, TaskFilterControl } from "./TaskFilterControl";
import type { FilterGroup, SavedTaskFilter } from "./task-filter";
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
    readonly groups: readonly FilterGroup[];
    readonly onGroupsChange: (next: readonly FilterGroup[]) => void;
    readonly fields: readonly TaskField[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    readonly tags: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    readonly currentUserId: number | null;
    readonly savedFilters: readonly SavedTaskFilter[];
    readonly onSaveFilter: (name: string, groups: readonly FilterGroup[]) => void;
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
    groups,
    onGroupsChange,
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
    isFiltering,
    onClearFilters,
    isRefreshing,
    onRefresh,
    isSubtasksExpanded,
    onSubtasksExpandedChange,
}: TasksToolbarProps) {
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
                    <TaskFilterControl
                        chrome={false}
                        groups={groups}
                        onGroupsChange={onGroupsChange}
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
                        isFiltering={isFiltering}
                        onClear={onClearFilters}
                    />

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                variant="outline"
                                data-slot="task-subtasks-trigger"
                                aria-label={subtasksAriaLabel}
                                title={subtasksAriaLabel}
                                aria-haspopup="menu"
                                className={FILTER_BAR_ITEM_CLASS}
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

                    <Button
                        type="button"
                        variant="outline"
                        onClick={onRefresh}
                        disabled={isRefreshing}
                        aria-label="Refresh tasks"
                        title="Refresh tasks"
                        className={FILTER_BAR_ITEM_CLASS}
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

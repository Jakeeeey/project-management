"use client";

import { TaskCombobox } from "./TaskCombobox";
import type { TaskListSummary } from "../hooks/useTaskLists";

/**
 * The list switcher, rendered at the right end of the view-tabs row.
 *
 * Lists come from the `pm_task_list` TABLE, so the module's own rule applies: a database-sourced,
 * dynamic row set is a searchable `TaskCombobox`, not a plain `Select`. Selecting a list changes
 * which list's tasks every view shows; the control is deliberately NOT permission-gated — viewing
 * any list of one's own department is the normal case, not a boundary.
 *
 * It shares the row with the view tabs — tabs left, switcher right — because the list is a
 * PAGE-level scope: it decides which list's rows every view (List, Board, Calendar, Team, Gantt,
 * Dashboard) projects. That is a different axis from the tabs, which pick the REPRESENTATION of
 * those already-chosen rows, from the toolbar's search box, which only narrows them further, and
 * from the page actions, which stay on the heading row. `sm:ml-auto` is what right-aligns it on
 * that row, and it also pins the control right when the row wraps it onto its own line.
 *
 * The control owns its own width rather than inheriting a caller's. A list name is not a fixed-width
 * catalog label, and a shrink-to-content row would collapse the trigger until realistic names
 * truncated to fragments. Full width while the row is stacked, then a bounded track from `sm:` up,
 * keeps that promise without crowding the view tabs beside it.
 */
export interface TaskListSwitcherProps {
    /** The department's live lists, ordered by `(sort_order, id)`. */
    readonly lists: readonly TaskListSummary[];
    /** The list currently in view, or `null` while the lists are still loading. */
    readonly selectedId: number | null;
    readonly onSelect: (id: number) => void;
}

export function TaskListSwitcher({ lists, selectedId, onSelect }: TaskListSwitcherProps) {
    /*
     * Nothing to choose between until the lists load — and the mount-time bootstrap guarantees at
     * least the department's default list, so an empty set means "not loaded yet", never "no lists
     * exist". Rendering an empty combobox would offer a control with no options; the toolbar simply
     * shows the search box until there is a list to scope to.
     */
    if (lists.length === 0) return null;

    return (
        <div
            data-slot="task-list-switcher"
            className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-64 lg:w-72"
        >
            <TaskCombobox
                /*
                 * A list is not a catalog row: it has no status and no stored icon, so the
                 * combobox's leading glyph is skipped and each list reads as plain text, with the
                 * selected row's check as the only mark. Rendering the fallback marker here is what
                 * made every option look like an unselected radio button.
                 */
                showStatusIcon={false}
                options={lists.map((list) => ({ value: String(list.id), label: list.name }))}
                value={selectedId === null ? null : String(selectedId)}
                onValueChange={(next) => {
                    if (next === null) return;
                    onSelect(Number(next));
                }}
                placeholder="Select a list"
                ariaLabel="Task list"
                searchPlaceholder="Search lists..."
                emptyMessage="No lists match."
                clearable={false}
            />
        </div>
    );
}

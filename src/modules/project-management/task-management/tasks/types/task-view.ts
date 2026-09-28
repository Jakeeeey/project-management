import type { CellEditRequest } from "../components/TaskCellEditor";
import type { TaskCatalogs, TaskField, TaskListItem } from "../hooks/useTasks";

/**
 * The view contracts for the tasks page.
 *
 * The tasks page renders one of six views over the SAME already-fetched department rows — the list
 * (the existing tree) plus Board, Calendar, Team, Gantt and Dashboard. Every view is presentational:
 * it receives the flat rows, the catalogs and the member directory as props and derives its own
 * projection. Nothing here fetches, and nothing here writes: all five extra views are READ-ONLY.
 *
 * This file is the frozen interface between the page shell and the views, so a view can be built and
 * reviewed without touching the shell, and the shell can add a view without knowing how it works.
 */

/** The six views the tasks page can show. `list` is the default and the only editable one. */
export type TasksViewId = "list" | "board" | "calendar" | "team" | "gantt" | "dashboard";

/** The tab order, which is also the render order of the view switcher. */
export const TASKS_VIEW_ORDER: readonly TasksViewId[] = [
    "list",
    "board",
    "calendar",
    "team",
    "gantt",
    "dashboard",
];

/** The human label of each view, so the switcher and the view headings never disagree. */
export const TASKS_VIEW_LABELS: Record<TasksViewId, string> = {
    list: "List",
    board: "Board",
    calendar: "Calendar",
    team: "Team",
    gantt: "Gantt",
    dashboard: "Dashboard",
};

/**
 * Everything a non-list view reads.
 *
 * `items` is the department's **flat** row set, exactly as the list route returns it — a view decides
 * its own grouping, and no view may assume the rows are ordered by anything but `(sort_order, id)`.
 * `memberNameById` is the only way to name an assignee: a row carries user ids, never names, and a
 * miss must render `User #<id>` rather than a blank.
 */
export interface TaskViewProps {
    /** The department's live rows, flat. */
    readonly items: readonly TaskListItem[];
    /** Both per-department catalogs — the Board's columns and every badge's colours come from here. */
    readonly catalogs: TaskCatalogs;
    /** Display names keyed by user id (from `useAssignees`). */
    readonly memberNameById: ReadonlyMap<number, string>;
    /** The department's custom columns, for a view that wants to surface them. */
    readonly fields: readonly TaskField[];
    /** True during the cold load, which renders a skeleton rather than an empty view. */
    readonly isLoading: boolean;
    /** A non-empty string renders the shared error state. */
    readonly error: string | null;
    /** Retries the load; the shell owns the fetcher. */
    readonly onRetry: () => void;
    /**
     * Opens the read view for one task — the same surface the list's row action opens.
     *
     * OPTIONAL, and a view that is not handed it must not present a task as clickable: the
     * affordance and the capability are the same fact, so a view without the seam stays exactly as
     * passive as it was before the seam existed.
     */
    readonly onOpenTask?: (taskId: number) => void;
    /**
     * Commits ONE field change for one task, through the shell's single write path (the same
     * `resolveCellEdit` the table's inline editors use). `column` is the caller's own identity for
     * the in-flight guard, not a field selector — the request carries what is being changed.
     *
     * OPTIONAL, and only the board is handed it. Presence is what licenses a WRITE-capable view:
     * dragging a card between columns is offered only because this seam exists, so the contract
     * cannot drift from what the view may do.
     */
    readonly onCellCommit?: (taskId: number, column: string, request: CellEditRequest) => void;
}

/** The display name of an assignee id, or a stable fallback — never a blank label. */
export function assigneeName(userId: number, memberNameById: ReadonlyMap<number, string>): string {
    return memberNameById.get(userId) ?? `User #${userId}`;
}
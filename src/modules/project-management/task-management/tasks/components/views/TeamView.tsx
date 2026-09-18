"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronRight, ListTree, RotateCcw, TriangleAlert, UserX, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import {
    assigneeColorFor,
    assigneeForegroundFor,
} from "../assignee-color";

import { assigneeName, type TaskViewProps } from "../../types/task-view";
import type { TaskListItem } from "../../hooks/useTasks";
import { TaskPriorityBadge, TaskStatusBadge } from "../TaskRowBadges";
import { formatTaskDate, formatTaskDateRange } from "../TaskRow";

/**
 * One workload bucket: either a named assignee's tasks or the department's unassigned tasks.
 *
 * Ordering is resolved at build time (never at render), so the section order is stable across
 * re-renders and the unassigned bucket is always last.
 */
interface TeamSection {
    readonly kind: "assignee" | "unassigned";
    /** A stable React key; the id for an assignee, the literal `unassigned` for the tail bucket. */
    readonly key: string;
    /** The assignee's user id, or `null` for the unassigned bucket. */
    readonly userId: number | null;
    /** The resolved display name — the unassigned bucket is titled by the view, not the directory. */
    readonly name: string;
    readonly tasks: readonly TaskListItem[];
}

/** The two-value label for a section's task count, pluralised by the data itself. */
function taskCountLabel(count: number): string {
    return `${count} task${count === 1 ? "" : "s"}`;
}

/** A stable title/name ordering — locale-aware, case-insensitive, and numeric-safe. */
function compareLabels(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** "Maria Santos" → "MS"; a single-word name keeps its first letter (mirrors the assignee stack). */
function initialsOf(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
    return `${first}${last}`.toUpperCase();
}

/** Caps an open member's list at ~5 rows so one prolific member cannot stretch the page either. */
const TASK_LIST_MAX_HEIGHT_CLASS = "max-h-80";

/** The unassigned bucket's heading, kept in one place so the summary and the section never disagree. */
const UNASSIGNED_TITLE = "Unassigned";

/**
 * Read-only per-assignee workload view of the department's tasks.
 *
 * This is the Team view of the tasks page: it groups the same flat row set the list returns by
 * assignee and answers "who is carrying what". Grouping is deliberately **not** de-duplicating — a
 * task with N assignees appears under each of them, because a shared task IS workload for every one
 * of them; the top summary still counts each task once, which is why the section counts can sum to
 * more than the assigned total.
 *
 * Assigned members come first in display-name order and the unassigned bucket always closes the
 * list, so the same data always produces the same page. Every fact on a card (title, status
 * badges, dates) comes from the row or the member directory the shell passed in; nothing here
 * fetches, and nothing here writes — the shell owns retries, and this view only forwards `onRetry`.
 *
 * @param props - the frozen `TaskViewProps` contract; the shell passes already-fetched data.
 */
export function TeamView({
    items,
    memberNameById,
    isLoading,
    error,
    onRetry,
}: TaskViewProps) {
    /**
     * The sections plus the two summary totals, derived in ONE pass so the layout and the summary
     * can never drift. Tasks are bucketed by user id (ids only — names are looked up through
     * `assigneeName`), and every section's rows are sorted by title once, here, rather than on
     * every render.
     */
    const { sections, assignedCount, unassignedCount } = useMemo(() => {
        const byAssignee = new Map<number, TaskListItem[]>();
        const unassigned: TaskListItem[] = [];
        let assigned = 0;

        for (const task of items) {
            if (task.assignees.length === 0) {
                unassigned.push(task);
                continue;
            }

            assigned += 1;
            for (const assignee of task.assignees) {
                const bucket = byAssignee.get(assignee.user_id);
                if (bucket === undefined) byAssignee.set(assignee.user_id, [task]);
                else bucket.push(task);
            }
        }

        const sortedByTitle = (tasks: TaskListItem[]): TaskListItem[] =>
            [...tasks].sort((a, b) => compareLabels(a.title, b.title));

        const assigneeSections: TeamSection[] = [...byAssignee.entries()]
            .map(([userId, tasks]) => ({
                kind: "assignee" as const,
                key: `user-${userId}`,
                userId,
                name: assigneeName(userId, memberNameById),
                tasks: sortedByTitle(tasks),
            }))
            .sort((a, b) => compareLabels(a.name, b.name));

        const nextSections: TeamSection[] = [
            ...assigneeSections,
            {
                kind: "unassigned",
                key: "unassigned",
                userId: null,
                name: UNASSIGNED_TITLE,
                tasks: sortedByTitle(unassigned),
            },
        ];

        return { sections: nextSections, assignedCount: assigned, unassignedCount: unassigned.length };
    }, [items, memberNameById]);

    /**
     * Which member sections are open. MULTI-expand and all-collapsed by default: the view's job is to
     * compare who is carrying what, so opening one member must not close another, and the collapsed
     * page is bounded to one header per member (each header still shows the count).
     */
    const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());

    const toggleSection = useCallback((key: string) => {
        setExpandedKeys((previous) => {
            const next = new Set(previous);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    if (isLoading) return <TeamSkeleton />;

    if (error !== null && error !== "") {
        return (
            <div
                data-slot="task-team-error"
                role="alert"
                className="flex h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
            >
                <TriangleAlert className="size-8 text-destructive" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Try again
                </Button>
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div
                data-slot="task-team-empty"
                className="flex h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-border/50 bg-card p-6 text-center shadow-sm"
            >
                <ListTree className="size-8 text-muted-foreground/50" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">No tasks in this department yet.</p>
            </div>
        );
    }

    return (
        <div data-slot="task-team" className="w-full min-w-0 space-y-3">
            <p data-slot="task-team-summary" className="text-sm text-muted-foreground">
                <span className="font-medium tabular-nums text-foreground">{assignedCount}</span>{" "}
                assigned
                <span aria-hidden="true"> · </span>
                <span className="font-medium tabular-nums text-foreground">{unassignedCount}</span>{" "}
                unassigned
            </p>

            <div className="flex flex-col gap-3">
                {sections.map((section) => (
                    <TeamSectionCard
                        key={section.key}
                        section={section}
                        isExpanded={expandedKeys.has(section.key)}
                        onToggle={() => toggleSection(section.key)}
                    />
                ))}
            </div>
        </div>
    );
}

interface TeamSectionCardProps {
    section: TeamSection;
    /** Whether this member's task list is open; the parent owns the open set. */
    isExpanded: boolean;
    /** Flips this member's section open/closed. */
    onToggle: () => void;
}

/**
 * One workload bucket as an accordion row: a header that toggles the task list beneath it.
 *
 * The header is a real `<button>` inside the `h3`, so it is keyboard operable and reports
 * `aria-expanded` for free. The task list renders ONLY while open, so a collapsed department costs
 * one header per member rather than one list per member.
 */
function TeamSectionCard({ section, isExpanded, onToggle }: TeamSectionCardProps) {
    const isUnassigned = section.kind === "unassigned";
    const countLabel = taskCountLabel(section.tasks.length);
    const hasTasks = section.tasks.length > 0;
    const HeadingIcon = isUnassigned ? UserX : Users;
    const panelId = `task-team-panel-${section.key}`;

    // The unassigned bucket is not a person, so it keeps the neutral icon; a real member gets their
    // derived assignee colour, matching their chip everywhere else in the module.
    const memberColor = section.userId === null ? null : assigneeColorFor(section.userId);

    const toggleLabel = isUnassigned
        ? `${isExpanded ? "Collapse" : "Expand"} unassigned tasks (${section.tasks.length})`
        : `${isExpanded ? "Collapse" : "Expand"} ${section.name}'s tasks (${section.tasks.length})`;

    return (
        <section
            data-slot="task-team-section"
            data-user-id={section.userId ?? undefined}
            data-expanded={isExpanded}
            aria-label={section.name}
            className={cn(
                "flex min-w-0 flex-col overflow-hidden rounded-2xl border",
                // The unassigned bucket is deliberately quieter than a real member's card, so the
                // eye reads it as "leftovers" rather than as another person.
                isUnassigned
                    ? "border-dashed border-border/60 bg-muted/30"
                    : "border-border/50 bg-card shadow-sm",
            )}
        >
            <h3 className="min-w-0">
                <button
                    type="button"
                    data-slot="task-team-section-toggle"
                    data-user-id={section.userId ?? undefined}
                    aria-expanded={isExpanded}
                    aria-controls={panelId}
                    aria-label={toggleLabel}
                    onClick={onToggle}
                    className="flex w-full items-center justify-between gap-2 p-4 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                    <span className="flex min-w-0 items-center gap-2">
                        {memberColor === null ? (
                            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                                <HeadingIcon
                                    className="size-4 text-muted-foreground/70"
                                    aria-hidden="true"
                                />
                            </span>
                        ) : (
                            <span
                                data-slot="task-team-section-avatar"
                                aria-hidden="true"
                                className="flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                                style={{
                                    backgroundColor: memberColor,
                                    color: assigneeForegroundFor(memberColor),
                                }}
                            >
                                {initialsOf(section.name)}
                            </span>
                        )}
                        <span
                            className={cn(
                                "truncate text-sm font-semibold",
                                isUnassigned && "text-muted-foreground",
                            )}
                            title={section.name}
                        >
                            {section.name}
                        </span>
                    </span>

                    <span className="flex shrink-0 items-center gap-2">
                        <Badge
                            variant="secondary"
                            data-slot="task-team-section-count"
                            title={countLabel}
                            className="shrink-0 border-border/60 px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground"
                        >
                            <span aria-hidden="true">{section.tasks.length}</span>
                            <span className="sr-only">{countLabel}</span>
                        </Badge>
                        <ChevronRight
                            className={cn(
                                "size-4 shrink-0 text-muted-foreground transition-transform",
                                isExpanded && "rotate-90",
                            )}
                            aria-hidden="true"
                        />
                    </span>
                </button>
            </h3>

            {isExpanded ? (
                <div
                    id={panelId}
                    data-slot="task-team-section-panel"
                    role="region"
                    aria-label={`${section.name} tasks`}
                    tabIndex={hasTasks ? 0 : undefined}
                    className={cn(
                        "min-w-0 px-4 pb-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        hasTasks && `${TASK_LIST_MAX_HEIGHT_CLASS} overflow-y-auto overscroll-contain`,
                    )}
                >
                    {hasTasks ? (
                        <ul className="flex min-w-0 flex-col gap-2">
                            {section.tasks.map((task) => (
                                <TeamTaskRow key={task.id} task={task} isMuted={isUnassigned} />
                            ))}
                        </ul>
                    ) : (
                        <p className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                            Nothing unassigned
                        </p>
                    )}
                </div>
            ) : null}
        </section>
    );
}

interface TeamTaskRowProps {
    task: TaskListItem;
    /** Inside the muted unassigned card, rows flip to the raised surface so they stay legible. */
    isMuted: boolean;
}

/** One task on a workload card: its title, both catalog badges and its date range. */
function TeamTaskRow({ task, isMuted }: TeamTaskRowProps) {
    const rangeText = formatTaskDateRange(task.start_date, task.end_date);
    const rangeTitle = `Start: ${formatTaskDate(task.start_date)} · Due: ${formatTaskDate(task.end_date)}`;

    return (
        <li
            data-slot="task-team-card"
            data-task-id={task.id}
            className={cn(
                "min-w-0 rounded-xl border border-border/50 p-2.5",
                isMuted ? "bg-card" : "bg-muted/30",
            )}
        >
            <p className="truncate text-sm font-medium" title={task.title}>
                {task.title}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <TaskStatusBadge status={task.status} />
                <TaskPriorityBadge priority={task.priority} />
                <span
                    className="ml-auto min-w-0 shrink-0 text-xs text-muted-foreground"
                    title={rangeTitle}
                >
                    {rangeText}
                </span>
            </div>
        </li>
    );
}

/** Fixed placeholder counts — the assignees are unknown during a cold load, so the shape is faked. */
const SKELETON_SECTIONS: readonly string[] = ["one", "two", "three"];

/** The team view's cold-load skeleton, shaped like the stacked, all-collapsed accordion. */
function TeamSkeleton() {
    return (
        <div
            data-slot="task-team-loading"
            role="status"
            aria-label="Loading tasks"
            className="w-full min-w-0 space-y-3"
        >
            <Skeleton className="h-5 w-56" />
            <div className="flex flex-col gap-3">
                {SKELETON_SECTIONS.map((section) => (
                    <div
                        key={section}
                        className="flex min-w-0 items-center justify-between gap-2 rounded-2xl border border-border/50 bg-card p-4 shadow-sm"
                    >
                        <Skeleton className="h-5 w-40" />
                        <Skeleton className="h-5 w-8 rounded-full" />
                    </div>
                ))}
            </div>
            <span className="sr-only">Loading tasks…</span>
        </div>
    );
}

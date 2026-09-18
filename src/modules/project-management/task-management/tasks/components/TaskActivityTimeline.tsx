"use client";

import { ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useTaskActivity, type TaskActivityEntry } from "../hooks/useTaskActivity";
import { formatTaskDateCompact } from "./TaskRow";

/**
 * One task's change history, rendered as a timeline grouped by SAVE.
 *
 * `pm_task_activity` stores one ROW per changed field and groups the rows of one logical save under
 * a shared `batch_id`. A save that moved both the status and the due date is therefore two rows but
 * ONE event, and that is how this component shows it: each distinct `batch_id` becomes a single
 * entry ("changed Status and Due date") whose body lists the field changes — never two unrelated
 * lines. Rows sharing a batch share `actor_label` and `changed_at`, so the header is read from the
 * first row of the group.
 *
 * Every value rendered here is the SNAPSHOT the writer took: `new_label` / `old_label` are the
 * display text as it read at the time, and only when a label is absent does the raw value stand in.
 * Nothing is re-resolved against a live catalog, because a later rename must not rewrite history.
 *
 * A `null` new side is handled honestly: on an update it reads as "cleared", and on a create it is
 * simply omitted from the initial-values list rather than rendered as "changed to null".
 *
 * No chip is used for a status/priority value on purpose. `CatalogChip` tints itself from a catalog
 * row's stored hex, but the activity snapshot does not carry the colour (only the label), so a chip
 * here would be a colourless pill pretending to be the real badge. The label renders as plain text,
 * which is honest. See `CatalogChip` for the surface that DOES have a colour.
 */

/** The actor shown when a batch's `actor_label` could not be resolved at write time. */
const UNKNOWN_ACTOR = "Someone";

/** The heading and the calm fallback for a task whose history has not started yet. */
const EMPTY_MESSAGE = "No changes recorded yet";

/** One save's worth of rows, with its header fields lifted from the batch's first row. */
interface ActivityEvent {
    readonly key: string;
    readonly action: string;
    readonly actorLabel: string;
    readonly changedAt: string | null;
    readonly changes: readonly TaskActivityEntry[];
}

/** The label to show for a field: its snapshot name, or the key when a legacy row has no label. */
function fieldLabel(entry: TaskActivityEntry): string {
    const label = entry.field_label.trim();
    if (label !== "") return label;
    const key = entry.field_key.trim();
    return key !== "" ? key : "Field";
}

/**
 * The display text of one side of a change: the snapshot LABEL when it exists, else the raw VALUE.
 *
 * A `null` on both means "no display text for this value" — which is a real state (a cleared field,
 * or an unresolved reference the writer chose not to name), not a bug, so it is never back-filled
 * from an id.
 */
function displayText(label: string | null, value: string | null): string | null {
    const preferred = label?.trim();
    if (preferred !== undefined && preferred !== "") return preferred;
    const raw = value?.trim();
    return raw !== undefined && raw !== "" ? raw : null;
}

/** A stored PH timestamp as compact display text; never parsed into a `Date`, so no zone can shift it. */
function formatStamp(value: string | null): string {
    if (value === null) return "";
    const datePart = value.slice(0, 10);
    const timePart = value.slice(11, 16);
    const hasRealDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart);
    if (!hasRealDate) return value;
    return timePart === "" ? formatTaskDateCompact(datePart) : `${formatTaskDateCompact(datePart)} · ${timePart}`;
}

/** `A`, `A and B`, `A, B and C` — the human list used in an update event's summary. */
function joinLabels(labels: readonly string[]): string {
    if (labels.length === 0) return "";
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Groups the newest-first rows by `batch_id`, preserving the incoming order.
 *
 * A `null` batch (a pre-batch legacy row) becomes its own single-row event so it can never be
 * merged with an unrelated row. Within a group the rows are ordered by id ascending, which is the
 * order the writer recorded them.
 */
function groupByBatch(entries: readonly TaskActivityEntry[]): ActivityEvent[] {
    const order: string[] = [];
    const buckets = new Map<string, TaskActivityEntry[]>();

    for (const entry of entries) {
        const key = entry.batch_id ?? `row:${entry.id}`;
        const bucket = buckets.get(key);
        if (bucket === undefined) {
            buckets.set(key, [entry]);
            order.push(key);
        } else {
            bucket.push(entry);
        }
    }

    return order.map((key) => {
        const rows = [...(buckets.get(key) ?? [])].sort((a, b) => a.id - b.id);
        const first = rows[0];
        return {
            key,
            action: first?.action ?? "updated",
            actorLabel: first?.actor_label ?? UNKNOWN_ACTOR,
            changedAt: first?.changed_at ?? null,
            changes: rows,
        };
    });
}

/** The header sentence: a create reads as a creation, an update names the fields it touched. */
function eventSummary(event: ActivityEvent): string {
    if (event.action === "created") {
        return `${event.actorLabel} created this task`;
    }

    const labels: string[] = [];
    const seen = new Set<string>();
    for (const change of event.changes) {
        const label = fieldLabel(change);
        if (seen.has(label)) continue;
        seen.add(label);
        labels.push(label);
    }

    return labels.length === 0
        ? `${event.actorLabel} updated this task`
        : `${event.actorLabel} changed ${joinLabels(labels)}`;
}

/** The field label + value pair of one change line; a create or a clear takes its own phrasing. */
function changeLine(change: TaskActivityEntry, action: string): { label: string; value: string } | null {
    const label = fieldLabel(change);
    const next = displayText(change.new_label, change.new_value);
    const previous = displayText(change.old_label, change.old_value);

    if (action === "created") {
        // A create has no pre-state, so only the values it actually set are worth listing.
        return next === null ? null : { label: `${label}:`, value: next };
    }

    if (next === null) return { label, value: "cleared" };
    if (previous === null) return { label: `${label} set to`, value: next };
    return { label: `${label}:`, value: `${previous} → ${next}` };
}

export interface TaskActivityTimelineProps {
    /** The task whose history to show. The hook fetches whenever this changes. */
    readonly taskId: number;
}

/**
 * The sheet's audit display: this task's changes, newest save first.
 *
 * It owns its own fetch through `useTaskActivity`, so opening the sheet for a task is the only
 * thing that triggers a request. A failure is quiet — a muted message, never a thrown error or a
 * toast — because the history is a secondary surface and must not disturb the task being read.
 */
export function TaskActivityTimeline({ taskId }: TaskActivityTimelineProps) {
    const { entries, isLoading, isLoadingMore, error, hasMore, loadMore } = useTaskActivity(taskId);

    const events = groupByBatch(entries);

    return (
        <section data-slot="task-activity-timeline" className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">History</p>

            {isLoading ? (
                <p
                    data-slot="task-activity-loading"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    Loading history…
                </p>
            ) : error !== null ? (
                <p data-slot="task-activity-error" className="text-sm text-muted-foreground">
                    History is unavailable right now.
                </p>
            ) : events.length === 0 ? (
                <p data-slot="task-activity-empty" className="text-sm text-muted-foreground">
                    {EMPTY_MESSAGE}
                </p>
            ) : (
                <ol data-slot="task-activity-events" className="space-y-2.5">
                    {events.map((event) => {
                        const lines = event.changes
                            .map((change) => changeLine(change, event.action))
                            .filter((line): line is { label: string; value: string } => line !== null);
                        const stamp = formatStamp(event.changedAt);

                        return (
                            <li
                                key={event.key}
                                data-slot="task-activity-event"
                                data-action={event.action}
                                className="space-y-1 border-l-2 border-border/60 pl-2.5"
                            >
                                <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                                    <p className="min-w-0 text-sm font-medium break-words">
                                        {eventSummary(event)}
                                    </p>
                                    {stamp === "" ? null : (
                                        <time className="shrink-0 text-xs text-muted-foreground">
                                            {stamp}
                                        </time>
                                    )}
                                </div>

                                {lines.length === 0 ? null : (
                                    <ul className="space-y-1">
                                        {lines.map((line, index) => (
                                            <li
                                                key={`${event.key}:${index}`}
                                                data-slot="task-activity-change"
                                                title={`${line.label} ${line.value}`}
                                                className="min-w-0 truncate text-sm"
                                            >
                                                <span className="text-muted-foreground">{line.label}</span>{" "}
                                                <span>{line.value}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </li>
                        );
                    })}
                </ol>
            )}

            {hasMore ? (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={loadMore}
                    disabled={isLoadingMore}
                    data-slot="task-activity-load-more"
                    className="w-full"
                >
                    {isLoadingMore ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                        <ChevronDown className="size-3.5" aria-hidden="true" />
                    )}
                    {isLoadingMore ? "Loading…" : "Load older changes"}
                </Button>
            ) : null}
        </section>
    );
}

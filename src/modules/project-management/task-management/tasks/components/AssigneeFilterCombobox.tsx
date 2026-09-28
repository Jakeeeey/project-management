"use client";

import { useMemo } from "react";

import type { TaskListItem } from "../hooks/useTasks";
import { assigneeName } from "../types/task-view";
import { assigneeColorFor } from "./assignee-color";
import { AssigneeStack } from "./AssigneeStack";
import { MultiSelectCombobox, type MultiSelectComboboxOption } from "./MultiSelectCombobox";

/**
 * The assignee filter as ONE control, so every view that filters by people filters identically.
 *
 * The chart's filter and the board's filter are the same concern — pick people, keep the rows that
 * carry any of them — and they must not drift in their option set, their colour, their OR semantics
 * or their trigger. A caller therefore supplies only the row set it filters and the constraint
 * values; the derivation, the predicate and the avatar-stack summary all live here.
 */

/**
 * The people who appear on at least one of the rows — the only sensible filter options.
 *
 * Ordering is by display name rather than by id, which is an accident of row order, so the list
 * reads as a directory. The colour comes from the SAME derivation the table's avatars use, so a
 * person filtered here is the same colour as their avatar everywhere else.
 */
export function assigneeFilterOptions(
    items: readonly TaskListItem[],
    memberNameById: ReadonlyMap<number, string>,
): MultiSelectComboboxOption[] {
    const seen = new Set<number>();
    for (const item of items) {
        for (const assignee of item.assignees) {
            seen.add(assignee.user_id);
        }
    }

    return Array.from(seen)
        .sort((left, right) =>
            assigneeName(left, memberNameById).localeCompare(assigneeName(right, memberNameById)),
        )
        .map((userId) => ({
            value: String(userId),
            label: assigneeName(userId, memberNameById),
            color: assigneeColorFor(userId),
        }));
}

/**
 * The rows that carry ANY of the picked people — an **OR**, never an intersection.
 *
 * Picking a second person therefore ADDS their rows instead of narrowing to rows carrying both. An
 * empty selection short-circuits to the original array reference, so the unfiltered path allocates
 * nothing.
 */
export function filterItemsByAssignees(
    items: readonly TaskListItem[],
    values: readonly string[],
): readonly TaskListItem[] {
    if (values.length === 0) {
        return items;
    }

    const picked = new Set(values);
    return items.filter((item) =>
        item.assignees.some((assignee) => picked.has(String(assignee.user_id))),
    );
}

export interface AssigneeFilterComboboxProps {
    /** The rows the options are derived from — the caller's full, unfiltered set. */
    readonly items: readonly TaskListItem[];
    /** Display names keyed by user id; the one way to name an assignee. */
    readonly memberNameById: ReadonlyMap<number, string>;
    /** The picked user ids as decimal strings. Controlled. */
    readonly values: readonly string[];
    readonly onValuesChange: (values: string[]) => void;
    readonly className?: string;
}

/**
 * The trigger summarises the selection with the same overlapping avatar stack the table's assignee
 * cell uses, so a long selection stays one line instead of growing the control into a tower of
 * chips; the dropdown itself carries the searchable, check-marked list.
 */
export function AssigneeFilterCombobox({
    items,
    memberNameById,
    values,
    onValuesChange,
    className,
}: AssigneeFilterComboboxProps) {
    const options = useMemo(
        () => assigneeFilterOptions(items, memberNameById),
        [items, memberNameById],
    );

    return (
        <MultiSelectCombobox
            options={options}
            values={values}
            onValuesChange={onValuesChange}
            placeholder="Filter by assignee"
            searchPlaceholder="Search assignees..."
            emptyMessage="No assignees match."
            ariaLabel="Filter by assignee"
            className={className}
            renderSelectionSummary={(picked) => (
                <AssigneeStack
                    assignees={picked.map((value) => ({
                        user_id: Number(value),
                        full_name: assigneeName(Number(value), memberNameById),
                    }))}
                    max={3}
                />
            )}
        />
    );
}

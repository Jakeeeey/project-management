"use client";

import { useMemo } from "react";

import type { TaskListItem, TaskTagOption } from "../hooks/useTasks";
import { MultiSelectCombobox, type MultiSelectComboboxOption } from "./MultiSelectCombobox";

/**
 * The tag filter as ONE control, so the chart and any other view that filters by tag filter identically.
 *
 * Same shape as `AssigneeFilterCombobox` on purpose: options derived from the rows, an **OR**
 * predicate, and no local state. The tag catalog supplies the label and colour, so a tag reads the
 * same here as it does on a task row.
 */

/** The tags that appear on at least one of the rows — an unused tag is noise in a filter list. */
export function tagFilterOptions(
    items: readonly TaskListItem[],
    tags: readonly TaskTagOption[],
): MultiSelectComboboxOption[] {
    const seen = new Set<number>();
    for (const item of items) {
        for (const link of item.tags) {
            seen.add(link.tag_id);
        }
    }

    return tags
        .filter((tag) => seen.has(tag.id))
        .map((tag) => ({ value: String(tag.id), label: tag.label, color: tag.color }));
}

/**
 * The rows that carry ANY of the picked tags — an **OR**, never an intersection, matching the
 * assignee filter beside it. An empty selection short-circuits to the original array reference.
 */
export function filterItemsByTags(
    items: readonly TaskListItem[],
    values: readonly string[],
): readonly TaskListItem[] {
    if (values.length === 0) {
        return items;
    }

    const picked = new Set(values);
    return items.filter((item) => item.tags.some((link) => picked.has(String(link.tag_id))));
}

export interface TagFilterComboboxProps {
    /** The rows the options are derived from — the caller's full, unfiltered set. */
    readonly items: readonly TaskListItem[];
    /** The department's tag catalog; the label and colour come from here, never from the row. */
    readonly tags: readonly TaskTagOption[];
    /** The picked tag ids as decimal strings. Controlled. */
    readonly values: readonly string[];
    readonly onValuesChange: (values: string[]) => void;
    readonly className?: string;
}

export function TagFilterCombobox({
    items,
    tags,
    values,
    onValuesChange,
    className,
}: TagFilterComboboxProps) {
    const options = useMemo(() => tagFilterOptions(items, tags), [items, tags]);

    return (
        <MultiSelectCombobox
            options={options}
            values={values}
            onValuesChange={onValuesChange}
            placeholder="Filter by tag"
            searchPlaceholder="Search tags..."
            emptyMessage="No tags match."
            ariaLabel="Filter by tag"
            className={className}
        />
    );
}

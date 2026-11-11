"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandInput } from "@/components/ui/command";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { resolveCatalogHex } from "./CatalogChip";
import {
    MultiSelectChipRow,
    MultiSelectOptionList,
    type MultiSelectComboboxOption,
} from "./MultiSelectCombobox";
import type { TaskTagOption } from "../hooks/useTasks";

/**
 * The centered tags modal — the tag twin of `AssigneeDialog`.
 *
 * The Tags column is a fixed-WIDTH strip, so rendering the multiselect inline there would grow the
 * row instead of the interaction. The cell stays a circle stack and one click opens this modal, which
 * has room for the current selection, a search field and the whole department catalog.
 *
 * It owns only the DRAFT selection: it never fetches, never persists and knows nothing about routes.
 * The caller passes the task's current tag ids and receives the next set through `onSave`.
 */

export interface TaskTagsDialogTask {
    readonly id?: number;
    readonly title: string;
}

export interface TaskTagsDialogProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly task: TaskTagsDialogTask | null;
    /** The department's tag catalog — the picker's only source of options. */
    readonly tags: readonly TaskTagOption[];
    /** The task's current tag ids; seeds the draft every time the modal opens. */
    readonly selectedIds: readonly number[];
    readonly isSubmitting?: boolean;
    /** Receives the WHOLE chosen set; the caller diffs and persists it through the tag routes. */
    readonly onSave: (tagIds: readonly number[]) => void;
}

/** Keeps only positive integers — the same total bridge the form uses for assignees. */
function parseTagIds(values: readonly string[]): number[] {
    const ids: number[] = [];
    for (const value of values) {
        const id = Number(value);
        if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    return ids;
}

interface TaskTagsDialogBodyProps {
    readonly task: TaskTagsDialogTask;
    readonly tags: readonly TaskTagOption[];
    readonly selectedIds: readonly number[];
    readonly isSubmitting: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onSave: (tagIds: readonly number[]) => void;
}

/**
 * Mounted per open (the shell only renders it while open), so the draft seeds itself from the row on
 * every open with no syncing effect — closing and reopening always starts from the task's truth.
 */
function TaskTagsDialogBody({
    task,
    tags,
    selectedIds,
    isSubmitting,
    onOpenChange,
    onSave,
}: TaskTagsDialogBodyProps) {
    const [draft, setDraft] = useState<readonly string[]>(() =>
        selectedIds.map((id) => String(id)),
    );

    const options = useMemo<MultiSelectComboboxOption[]>(
        () =>
            tags.map((tag) => ({
                value: String(tag.id),
                label: tag.label,
                color: resolveCatalogHex(tag.color ?? null),
                // Any lucide id: the picker rows and the selected chips draw it through
                // `CatalogStatusIcon`, which has a dynamic path for ids outside the allow-list.
                icon: tag.icon,
            })),
        [tags],
    );

    const toggle = (value: string): void => {
        setDraft((current) =>
            current.includes(value)
                ? current.filter((entry) => entry !== value)
                : [...current, value],
        );
    };

    return (
        <DialogContent className="flex max-h-[85vh] w-[95vw] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[520px]">
            <DialogHeader className="border-b px-6 pt-6 pb-4">
                <DialogTitle className="line-clamp-1">Tags</DialogTitle>
                <DialogDescription className="line-clamp-1">
                    {`Choose the tags for ${task.title}.`}
                </DialogDescription>
            </DialogHeader>

            <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-b px-6 py-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                        Selected{draft.length > 0 ? ` (${draft.length})` : ""}
                    </p>
                    {draft.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No tags yet.</p>
                    ) : (
                        <MultiSelectChipRow options={options} values={draft} onRemove={toggle} />
                    )}
                </div>

                {tags.length === 0 ? (
                    <p className="px-6 py-6 text-sm text-muted-foreground">
                        Your department has no tags yet.
                    </p>
                ) : (
                    <Command className="min-h-0 flex-1 rounded-none bg-transparent">
                        <CommandInput placeholder="Search tags..." />
                        <MultiSelectOptionList
                            options={options}
                            selectedValues={draft}
                            onToggle={toggle}
                            emptyMessage="No matching tag."
                        />
                    </Command>
                )}
            </div>

            <DialogFooter className="justify-end border-t bg-muted/20 px-6 py-4">
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    disabled={isSubmitting}
                >
                    Cancel
                </Button>
                <Button
                    type="button"
                    onClick={() => onSave(parseTagIds(draft))}
                    disabled={isSubmitting || tags.length === 0}
                    className="min-h-11 md:min-h-0"
                >
                    Save
                </Button>
            </DialogFooter>
        </DialogContent>
    );
}

export function TaskTagsDialog({
    open,
    onOpenChange,
    task,
    tags,
    selectedIds,
    isSubmitting = false,
    onSave,
}: TaskTagsDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {open && task !== null ? (
                <TaskTagsDialogBody
                    task={task}
                    tags={tags}
                    selectedIds={selectedIds}
                    isSubmitting={isSubmitting}
                    onOpenChange={onOpenChange}
                    onSave={onSave}
                />
            ) : null}
        </Dialog>
    );
}

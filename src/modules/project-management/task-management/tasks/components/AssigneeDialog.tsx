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
import type { MemberAccessItem } from "@/modules/project-management/task-management/access/hooks/useAccess";
import { assigneeColorFor } from "@/modules/project-management/components/assignee-color";
import {
    MultiSelectChipRow,
    MultiSelectOptionList,
    type MultiSelectComboboxOption,
} from "@/modules/project-management/components/MultiSelectCombobox";

/**
 * The centered assignees modal.
 *
 * The on-table assignees cell is only 160px wide. Rendering the multi-select combobox INLINE there
 * (chips wrapping and growing the field) is what made assigning look clumped: four members stacked
 * into a narrow cell and pushed the row tall. The fix is to move the interaction into a modal that
 * has room, so the table cell stays a compact avatar stack and one click opens a comfortable picker.
 *
 * The modal deliberately holds NO nested popover. It shows everything at once — the current selection
 * as the SAME removable chips the combobox uses, a search field, and the scrollable member list — so
 * the user can add and remove members without a second surface opening on top of the first.
 *
 * ## Shared, so it cannot drift with the combobox
 *
 * Both the current-selection chips and the pickable list are the EXPORTED pieces of
 * `MultiSelectCombobox` ({@link MultiSelectChipRow} / {@link MultiSelectOptionList}). The modal and the
 * details form's assignee combobox therefore render identical chips and identical rows; a change to
 * either lives in one place.
 *
 * ## Controlled by contract
 *
 * It owns only the DRAFT selection. It never fetches, never persists and never knows about routes: the
 * caller passes the task's current assignee ids and receives the next ids through `onSave`. Cancel,
 * the header's X and a click on the overlay all abandon the draft.
 */

/**
 * The task the modal names in its header; only the title is ever rendered, so `id` is optional and
 * a create — which has no row yet — can pass a title-only subject.
 */
export interface AssigneeDialogTask {
    readonly id?: number;
    readonly title: string;
}

export interface AssigneeDialogProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    /** The task being edited, or `null` while closing (the modal then renders nothing meaningful). */
    readonly task: AssigneeDialogTask | null;
    /** The department's live members — the picker's only source of options. */
    readonly members: readonly MemberAccessItem[];
    /** The task's current assignee ids; seeds the draft every time the modal opens. */
    readonly selectedIds: readonly number[];
    /** True while an assign / unassign is in flight, so Save and Cancel cannot double-fire. */
    readonly isSubmitting?: boolean;
    /** Receives the WHOLE chosen set; the caller diffs and persists it through the assignees route. */
    readonly onSave: (userIds: readonly number[]) => void;
}

/** Keeps only the entries that are positive integers — the same total bridge the form uses. */
function parseAssigneeIds(values: readonly string[]): number[] {
    const ids: number[] = [];
    for (const value of values) {
        const id = Number(value);
        if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    return ids;
}

interface AssigneeDialogBodyProps {
    readonly task: AssigneeDialogTask;
    readonly members: readonly MemberAccessItem[];
    readonly selectedIds: readonly number[];
    readonly isSubmitting: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onSave: (userIds: readonly number[]) => void;
}

/**
 * The modal's interactive body. It is MOUNTED per open (the dialog route only renders it while open),
 * so its local draft seeds itself from the task's current assignees on every open without any syncing
 * effect — closing and reopening a task always starts from the row's truth, never the previous draft.
 */
function AssigneeDialogBody({
    task,
    members,
    selectedIds,
    isSubmitting,
    onOpenChange,
    onSave,
}: AssigneeDialogBodyProps) {
    const [draft, setDraft] = useState<readonly string[]>(() =>
        selectedIds.map((id) => String(id)),
    );

    /**
     * The department's members with the colour derived from their user id, so a member's chip and list
     * row here agree with their avatar in the table. The email rides along as search keywords so a
     * member can be found by email even though the list shows only names.
     */
    const options = useMemo<MultiSelectComboboxOption[]>(
        () =>
            members.map((member) => ({
                value: String(member.user_id),
                label: member.full_name,
                color: assigneeColorFor(member.user_id),
                keywords: member.user_email ?? "",
            })),
        [members],
    );

    const toggle = (value: string): void => {
        setDraft((current) =>
            current.includes(value)
                ? current.filter((entry) => entry !== value)
                : [...current, value],
        );
    };

    const handleSave = (): void => {
        onSave(parseAssigneeIds(draft));
    };

    return (
        <DialogContent className="flex max-h-[85vh] w-[95vw] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[520px]">
            <DialogHeader className="border-b px-6 pt-6 pb-4">
                <DialogTitle className="line-clamp-1">Assignees</DialogTitle>
                <DialogDescription className="line-clamp-1">
                    {`Choose who works on ${task.title}.`}
                </DialogDescription>
            </DialogHeader>

            <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-b px-6 py-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                        Selected{draft.length > 0 ? ` (${draft.length})` : ""}
                    </p>
                    {draft.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No assignees yet.</p>
                    ) : (
                        <MultiSelectChipRow options={options} values={draft} onRemove={toggle} />
                    )}
                </div>

                {/*
                 * A `Command` with NO popover around it: the search field and the list are part of
                 * the modal body. The shared list cap keeps a long member directory scrolling
                 * instead of stretching the dialog past the viewport.
                 */}
                <Command className="min-h-0 flex-1 rounded-none bg-transparent">
                    <CommandInput placeholder="Search members..." />
                    <MultiSelectOptionList
                        options={options}
                        selectedValues={draft}
                        onToggle={toggle}
                        emptyMessage="No matching member."
                    />
                </Command>
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
                    onClick={handleSave}
                    disabled={isSubmitting}
                    className="min-h-11 md:min-h-0"
                >
                    Save
                </Button>
            </DialogFooter>
        </DialogContent>
    );
}

/**
 * The controlled modal shell. It renders its body only while open and only for a real task, so every
 * open is a fresh mount and the draft can never leak between tasks or between openings.
 */
export function AssigneeDialog({
    open,
    onOpenChange,
    task,
    members,
    selectedIds,
    isSubmitting = false,
    onSave,
}: AssigneeDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {open && task !== null ? (
                <AssigneeDialogBody
                    task={task}
                    members={members}
                    selectedIds={selectedIds}
                    isSubmitting={isSubmitting}
                    onOpenChange={onOpenChange}
                    onSave={onSave}
                />
            ) : null}
        </Dialog>
    );
}

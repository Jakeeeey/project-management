"use client";

import { useMemo, useState } from "react";
import { Check, CornerDownRight, FolderTree } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type MoveTaskInput } from "@/modules/project-management/tasks/types/pm-task.schema";

import { computeMovePayload, isCycleTarget, listChildIds, type DndRow } from "./dnd-logic";

export interface MoveToParentDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The row being re-parented. */
    activeId: number | null;
    /** Every live row in the department — the whole tree, not just the visible projection. */
    rows: readonly DndRow[];
    /** Human label for a row id (the caller owns titles). */
    getLabel: (id: number) => string;
    /** Emits the pinned `{ parent_id, sibling_ids }` contract; the same shape a drop emits. */
    onSubmit: (payload: MoveTaskInput) => void;
    isSubmitting?: boolean;
}

type DestinationSelection = number | "root" | null;

/**
 * The accessible keyboard path for re-parenting.
 *
 * `sortableKeyboardCoordinates` gives sibling reorder only, by design; changing a row's parent from
 * the keyboard happens here instead. The dialog searches the tree for a destination, lets the user
 * pick a position among that destination's children, and emits exactly the same
 * `{ parent_id, sibling_ids }` payload a drag emits — one contract, both entry points.
 *
 * Rows that are the moved node or one of its descendants are filtered out of the destination list
 * (the cycle guard), so the dialog can never build a payload the move route would reject.
 *
 * Data-injectable: `rows` and `getLabel` are props, so it mounts with fixtures and no API.
 */
export function MoveToParentDialog({
    open,
    onOpenChange,
    activeId,
    rows,
    getLabel,
    onSubmit,
    isSubmitting = false,
}: MoveToParentDialogProps) {
    const [selection, setSelection] = useState<DestinationSelection>(null);
    const [insertIndex, setInsertIndex] = useState<number | null>(null);

    const activeLabel = activeId === null ? "" : getLabel(activeId);

    const candidateParents = useMemo(
        () => (activeId === null ? [] : rows.filter((row) => !isCycleTarget(rows, activeId, row.id))),
        [rows, activeId],
    );

    const resolvedParentId: number | null | undefined =
        selection === null ? undefined : selection === "root" ? null : selection;

    const siblings = useMemo(
        () =>
            activeId === null || resolvedParentId === undefined
                ? []
                : listChildIds(rows, resolvedParentId, activeId),
        [rows, activeId, resolvedParentId],
    );

    const positionOptions = useMemo(() => {
        const options: { value: string; label: string }[] = [
            { value: "0", label: siblings.length === 0 ? "Only position" : "At the beginning" },
        ];
        siblings.forEach((id, index) => {
            options.push({ value: String(index + 1), label: `After ${getLabel(id)}` });
        });
        return options;
    }, [siblings, getLabel]);

    const positionValue = insertIndex === null ? String(siblings.length) : String(insertIndex);

    const handleOpenChange = (next: boolean) => {
        if (!next) {
            setSelection(null);
            setInsertIndex(null);
        }
        onOpenChange(next);
    };

    const handleSubmit = () => {
        if (activeId === null || resolvedParentId === undefined) return;

        const destinationChildren = listChildIds(rows, resolvedParentId, activeId);
        const index =
            insertIndex !== null && insertIndex >= 0 && insertIndex <= destinationChildren.length
                ? insertIndex
                : destinationChildren.length;

        const payload = computeMovePayload(rows, activeId, resolvedParentId, index);
        if (payload === null) return;
        onSubmit(payload);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Move “{activeLabel}” to another parent</DialogTitle>
                    <DialogDescription>
                        Search for a destination task, choose where it should sit among that
                        destination&apos;s children, then move it.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-2">
                        <span className="text-sm font-medium">Destination parent</span>
                        <Command className="rounded-md border">
                            <CommandInput
                                placeholder="Search tasks…"
                                aria-label="Search destination parent"
                                autoFocus
                            />
                            <CommandList>
                                <CommandEmpty>No matching task.</CommandEmpty>
                                <CommandGroup heading="Destinations">
                                    <CommandItem
                                        value="top level root"
                                        onSelect={() => {
                                            setSelection("root");
                                            setInsertIndex(null);
                                        }}
                                    >
                                        <FolderTree className="size-4" aria-hidden="true" />
                                        <span className="truncate">Top level (root)</span>
                                        <Check
                                            className={cn(
                                                "ml-auto size-4",
                                                selection === "root" ? "opacity-100" : "opacity-0",
                                            )}
                                            aria-hidden="true"
                                        />
                                    </CommandItem>
                                    {candidateParents.map((row) => (
                                        <CommandItem
                                            key={row.id}
                                            value={`${row.id} ${getLabel(row.id)}`}
                                            onSelect={() => {
                                                setSelection(row.id);
                                                setInsertIndex(null);
                                            }}
                                        >
                                            <CornerDownRight className="size-4" aria-hidden="true" />
                                            <span className="truncate">{getLabel(row.id)}</span>
                                            <Check
                                                className={cn(
                                                    "ml-auto size-4",
                                                    selection === row.id ? "opacity-100" : "opacity-0",
                                                )}
                                                aria-hidden="true"
                                            />
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            </CommandList>
                        </Command>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="move-to-parent-position">Position among siblings</Label>
                        <Select
                            value={positionValue}
                            onValueChange={(value) => setInsertIndex(Number(value))}
                            disabled={selection === null}
                        >
                            <SelectTrigger
                                id="move-to-parent-position"
                                className="w-full"
                                aria-label="Position among siblings"
                            >
                                <SelectValue placeholder="Choose a destination first" />
                            </SelectTrigger>
                            <SelectContent className="max-h-64">
                                {positionOptions.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleOpenChange(false)}
                        disabled={isSubmitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={handleSubmit}
                        disabled={selection === null || isSubmitting}
                    >
                        {isSubmitting ? "Moving…" : "Move here"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

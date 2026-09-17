"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Loader2, UserPlus } from "lucide-react";

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
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import type { MemberAccessItem } from "../hooks/useAccess";

export interface AccessGrantDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Members who do NOT currently hold a grant — the only valid grant targets. */
    candidates: readonly MemberAccessItem[];
    /** True while the grant request is in flight — gates both footer buttons. */
    isSubmitting: boolean;
    /** Emits the chosen member's `user_id`; the caller performs the grant and closes on success. */
    onSubmit: (userId: number) => void | Promise<void>;
}

/**
 * The accessible, searchable path for granting Edit access.
 *
 * Granted members are removed from the picker (`candidates` arrives already filtered), so the list
 * only ever offers a legal target — there is no way to build a request the route would reject.
 *
 * The member picker is the canonical Popover + Command combobox: the trigger carries
 * `role="combobox"` + `aria-expanded`, the label truncates inside a `min-w-0 flex-1` span, and the
 * list is capped (`max-h-64 overflow-y-auto overscroll-contain`) so a 53-member department scrolls
 * inside the popover rather than growing the dialog.
 *
 * Width is the QA checklist's `S` tier (`sm:max-w-[500px]`) plus `w-[95vw]` so it always fits a
 * phone; the body scrolls inside a capped `max-h` while the header and footer stay pinned. Cancel
 * comes before Grant, and Grant is disabled for the whole in-flight window and until a member is
 * chosen.
 */
export function AccessGrantDialog({
    open,
    onOpenChange,
    candidates,
    isSubmitting,
    onSubmit,
}: AccessGrantDialogProps) {
    const [pickerOpen, setPickerOpen] = useState(false);
    const [selectedId, setSelectedId] = useState<number | null>(null);

    const selected = candidates.find((member) => member.user_id === selectedId) ?? null;

    /** A reopened dialog must never remember the previous pick, so the close path clears it. */
    const handleOpenChange = (next: boolean) => {
        if (!next) {
            setSelectedId(null);
            setPickerOpen(false);
        }
        onOpenChange(next);
    };

    const handleSubmit = async () => {
        if (selectedId === null) return;
        await onSubmit(selectedId);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="w-[95vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[500px]">
                <DialogHeader className="border-b px-6 pt-6 pb-4">
                    <DialogTitle className="line-clamp-1">Give Edit access</DialogTitle>
                    <DialogDescription>
                        Choose a department member who should have Edit access to this department&apos;s
                        tasks — including assigning people, setting status and priority, and changing
                        dates and custom fields. You can revoke this later.
                    </DialogDescription>
                </DialogHeader>

                <div className="max-h-[60vh] space-y-2 overflow-y-auto px-6 py-4">
                    {candidates.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Every member of this department already has Edit access.
                        </p>
                    ) : (
                        <>
                            <span className="text-sm font-medium">Member</span>
                            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                                <PopoverTrigger asChild>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        role="combobox"
                                        aria-expanded={pickerOpen}
                                        aria-label="Search for a department member"
                                        className="w-full justify-between"
                                    >
                                        <span
                                            className={cn(
                                                "min-w-0 flex-1 truncate text-left",
                                                selected === null && "text-muted-foreground",
                                            )}
                                            title={selected?.full_name}
                                        >
                                            {selected?.full_name ?? "Select a member…"}
                                        </span>
                                        <ChevronsUpDown
                                            className="ml-2 size-4 shrink-0 opacity-50"
                                            aria-hidden="true"
                                        />
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent
                                    align="start"
                                    className="w-(--radix-popover-trigger-width) p-0"
                                >
                                    <Command>
                                        <CommandInput
                                            placeholder="Search members by name or email…"
                                            aria-label="Search department members"
                                        />
                                        <CommandList className="max-h-64 overflow-y-auto overscroll-contain">
                                            <CommandEmpty>No matching member.</CommandEmpty>
                                            <CommandGroup heading="Members">
                                                {candidates.map((member) => (
                                                    <CommandItem
                                                        key={member.user_id}
                                                        value={`${member.user_id} ${member.full_name} ${member.user_email ?? ""}`}
                                                        onSelect={() => {
                                                            setSelectedId(member.user_id);
                                                            setPickerOpen(false);
                                                        }}
                                                    >
                                                        <Check
                                                            className={cn(
                                                                "mr-2 size-4 shrink-0",
                                                                selectedId === member.user_id
                                                                    ? "opacity-100"
                                                                    : "opacity-0",
                                                            )}
                                                            aria-hidden="true"
                                                        />
                                                        <span
                                                            className="min-w-0 flex-1 truncate"
                                                            title={member.full_name}
                                                        >
                                                            {member.full_name}
                                                        </span>
                                                        {member.user_email ? (
                                                            <span className="ml-2 max-w-[45%] truncate text-xs text-muted-foreground">
                                                                {member.user_email}
                                                            </span>
                                                        ) : null}
                                                    </CommandItem>
                                                ))}
                                            </CommandGroup>
                                        </CommandList>
                                    </Command>
                                </PopoverContent>
                            </Popover>
                        </>
                    )}
                </div>

                <DialogFooter className="border-t bg-muted/20 px-6 py-4">
                    <DialogClose asChild>
                        <Button type="button" variant="outline" disabled={isSubmitting}>
                            Cancel
                        </Button>
                    </DialogClose>
                    <Button
                        type="button"
                        onClick={() => {
                            void handleSubmit();
                        }}
                        disabled={selectedId === null || isSubmitting}
                        className="min-h-11 md:min-h-0"
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                Granting…
                            </>
                        ) : (
                            <>
                                <UserPlus className="size-4" aria-hidden="true" />
                                Grant Edit access
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

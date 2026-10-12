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

import { GRANT_CANDIDATE_PAGE_SIZE, useGrantCandidates } from "../hooks/useGrantCandidates";

export interface AccessGrantDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** True while the grant request is in flight — gates both footer buttons. */
    isSubmitting: boolean;
    /** Emits the chosen member's `user_id` with their display name; the caller grants and closes on success. */
    onSubmit: (userId: number, label: string) => void | Promise<void>;
}

/**
 * The accessible, searchable path for granting Edit access.
 *
 * The picker fetches its own candidates from the server (page 1 of a bounded, debounced `q`
 * search), so it covers the whole department rather than the roster's visible page. Granted
 * members and the actor arrive already excluded, so the list only ever offers a legal target.
 *
 * The member picker is the canonical Popover + Command combobox: the trigger carries
 * `role="combobox"` + `aria-expanded`, the label truncates inside a `min-w-0 flex-1` span, and the
 * list is capped (`max-h-64 overflow-y-auto overscroll-contain`) so a large department scrolls
 * inside the popover rather than growing the dialog.
 *
 * Width is the QA checklist's `S` tier (`sm:max-w-[500px]`) plus `w-[95vw]` so it always fits a
 * phone; the body scrolls inside a capped `max-h` while the header and footer stay pinned. Cancel
 * comes before Grant, and Grant is disabled for the whole in-flight window and until a member is
 * chosen.
 */
export function AccessGrantDialog({ open, onOpenChange, isSubmitting, onSubmit }: AccessGrantDialogProps) {
    const [pickerOpen, setPickerOpen] = useState(false);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [selectedLabel, setSelectedLabel] = useState<string | null>(null);

    const { query, candidates, hasMore, isLoading: isSearching, setQuery } = useGrantCandidates(open);

    const showAllGranted = !isSearching && candidates.length === 0 && query.trim() === "";

    /** A reopened dialog must never remember the previous pick, so the close path clears it. */
    const handleOpenChange = (next: boolean) => {
        if (!next) {
            setSelectedId(null);
            setSelectedLabel(null);
            setPickerOpen(false);
        }
        onOpenChange(next);
    };

    const handleSubmit = async () => {
        if (selectedId === null) return;
        await onSubmit(selectedId, selectedLabel ?? "The member");
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
                    {showAllGranted ? (
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
                                                selectedLabel === null && "text-muted-foreground",
                                            )}
                                            title={selectedLabel ?? undefined}
                                        >
                                            {selectedLabel ?? "Select a member…"}
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
                                    <Command shouldFilter={false}>
                                        <CommandInput
                                            placeholder="Search members by name or email…"
                                            aria-label="Search department members"
                                            value={query}
                                            onValueChange={setQuery}
                                        />
                                        <CommandList className="max-h-64 overflow-y-auto overscroll-contain">
                                            {isSearching && candidates.length === 0 ? (
                                                <p className="py-6 text-center text-sm text-muted-foreground">
                                                    Searching members…
                                                </p>
                                            ) : (
                                                <>
                                                    <CommandEmpty>No matching member.</CommandEmpty>
                                                    <CommandGroup heading="Members">
                                                        {candidates.map((member) => (
                                                            <CommandItem
                                                                key={member.user_id}
                                                                value={`${member.user_id} ${member.full_name} ${member.user_email ?? ""}`}
                                                                onSelect={() => {
                                                                    setSelectedId(member.user_id);
                                                                    setSelectedLabel(member.full_name);
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
                                                </>
                                            )}
                                        </CommandList>
                                    </Command>
                                </PopoverContent>
                            </Popover>
                            {hasMore ? (
                                <p className="text-xs text-muted-foreground">
                                    Showing the first {GRANT_CANDIDATE_PAGE_SIZE} matches — refine
                                    your search.
                                </p>
                            ) : null}
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

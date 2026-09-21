"use client";

import { useEffect, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

import { CreateTaskListSchema, type CreateTaskListInput } from "../../tasks/types/task-list.schema";
import type { TaskListSummary } from "../../tasks/hooks/useTaskLists";

export interface TaskListDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The list being renamed, or `null` when adding a new one. */
    item: TaskListSummary | null;
    /** True while any list mutation is in flight — gates both footer buttons. */
    isSubmitting: boolean;
    onSubmit: (name: string) => void | Promise<void>;
}

/**
 * The create/rename dialog for one task list.
 *
 * Validation reuses the SERVER's own `CreateTaskListSchema` rather than restating the bound, so the
 * client and the route can never disagree about what a valid name is (`VARCHAR(100)`, non-blank).
 */
export function TaskListDialog({
    open,
    onOpenChange,
    item,
    isSubmitting,
    onSubmit,
}: TaskListDialogProps) {
    const isEditing = item !== null;

    const form = useForm<CreateTaskListInput>({
        resolver: zodResolver(CreateTaskListSchema),
        defaultValues: { name: "" },
    });

    useEffect(() => {
        if (!open) return;
        form.reset({ name: item?.name ?? "" });
    }, [open, item, form]);

    const handleSubmit = form.handleSubmit(async (values) => {
        await onSubmit(values.name.trim());
    });

    let submitContent: ReactNode;
    if (isSubmitting) {
        submitContent = (
            <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Saving…
            </>
        );
    } else if (isEditing) {
        submitContent = "Save changes";
    } else {
        submitContent = "Add list";
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[95vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[500px]">
                <DialogHeader className="border-b px-6 pt-6 pb-4">
                    <DialogTitle className="line-clamp-1">
                        {isEditing ? "Rename list" : "Add list"}
                    </DialogTitle>
                    <DialogDescription>
                        {isEditing
                            ? "Tasks reference this list by its stored row, so a rename moves every task already in it to the new name."
                            : "Add a list to this department. Lists can stand for teams, workstreams, projects or anything else."}
                    </DialogDescription>
                </DialogHeader>

                <Form {...form}>
                    <form onSubmit={handleSubmit} className="flex flex-col">
                        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-6 py-4">
                            <FormField
                                control={form.control}
                                name="name"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>
                                            Name <span className="text-destructive">*</span>
                                        </FormLabel>
                                        <FormControl>
                                            <Input
                                                placeholder="e.g. Marketing"
                                                autoComplete="off"
                                                autoFocus
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormDescription>
                                            Shown in the list switcher and in the Configure list. Names are
                                            unique among this department&apos;s live lists.
                                        </FormDescription>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        </div>

                        <DialogFooter className="border-t bg-muted/20 px-6 py-4">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                                disabled={isSubmitting}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={isSubmitting} className="min-h-11 md:min-h-0">
                                {submitContent}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}

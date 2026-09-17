"use client";

import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Loader2 } from "lucide-react";
import { z } from "zod";

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
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

import { TaskFieldLabelSchema } from "../types/task-field.schema";
import type { TaskFieldOption } from "../hooks/useTasks";

/** A choice carries only a label — there is nothing else to collect. */
const OptionFormSchema = z.object({ label: TaskFieldLabelSchema });

type OptionFormValues = z.infer<typeof OptionFormSchema>;

export interface TaskFieldOptionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The choice being edited, or `null` when adding a new one. */
    option: TaskFieldOption | null;
    /** The label of the column this choice belongs to, so the copy can name it. */
    fieldLabel: string;
    isSubmitting: boolean;
    onSubmit: (label: string) => void | Promise<void>;
}

/** The create/edit dialog for one choice of a `select` column. */
export function TaskFieldOptionDialog({
    open,
    onOpenChange,
    option,
    fieldLabel,
    isSubmitting,
    onSubmit,
}: TaskFieldOptionDialogProps) {
    const isEditing = option !== null;

    const form = useForm<OptionFormValues>({
        resolver: zodResolver(OptionFormSchema),
        defaultValues: { label: "" },
    });

    useEffect(() => {
        if (!open) return;
        form.reset({ label: option?.label ?? "" });
    }, [open, option, form]);

    const handleSubmit = form.handleSubmit(async (values) => {
        await onSubmit(values.label.trim());
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[95vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[500px]">
                <DialogHeader className="border-b px-6 pt-6 pb-4">
                    <DialogTitle className="line-clamp-1">
                        {isEditing ? "Edit choice" : "Add choice"}
                    </DialogTitle>
                    <DialogDescription>
                        {isEditing
                            ? `Rename this choice of “${fieldLabel}”. Tasks that already picked it follow immediately.`
                            : `Add a choice to “${fieldLabel}”. Anyone editing a task can then pick it.`}
                    </DialogDescription>
                </DialogHeader>

                <Form {...form}>
                    <form onSubmit={handleSubmit} className="flex flex-col">
                        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-6 py-4">
                            <FormField
                                control={form.control}
                                name="label"
                                render={({ field: formField }) => (
                                    <FormItem>
                                        <FormLabel>
                                            Choice <span className="text-destructive">*</span>
                                        </FormLabel>
                                        <FormControl>
                                            <Input placeholder="e.g. Acme Corp" autoComplete="off" {...formField} />
                                        </FormControl>
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
                                className="min-h-11 md:min-h-0"
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={isSubmitting} className="min-h-11 md:min-h-0">
                                {isSubmitting ? (
                                    <>
                                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                        Saving…
                                    </>
                                ) : isEditing ? (
                                    "Save changes"
                                ) : (
                                    "Add choice"
                                )}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}
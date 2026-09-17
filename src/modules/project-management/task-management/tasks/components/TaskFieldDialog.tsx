"use client";

import { useEffect } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { CreateTaskFieldSchema, type CreateTaskFieldInput, type TaskFieldType } from "../types/task-field.schema";
import { fieldTypeLabel, type TaskFieldFormInput } from "../hooks/useTaskFields";
import type { TaskField } from "../hooks/useTasks";

/** The order the type picker offers them in — cheapest to describe first. */
const FIELD_TYPE_ORDER: readonly TaskFieldType[] = ["text", "number", "date", "select"];

export interface TaskFieldDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The column being edited, or `null` when adding a new one. */
    field: TaskField | null;
    /** True while any custom-field mutation is in flight — gates both footer buttons. */
    isSubmitting: boolean;
    onSubmit: (values: TaskFieldFormInput) => void | Promise<void>;
}

/**
 * The create/edit dialog for one custom column.
 *
 * The type picker is disabled while editing on purpose: a column's type is immutable after creation
 * (a `text` answer is not a `select` option id), so changing it means adding a new column and
 * removing the old one. The server refuses a type change too — this only stops the user reaching a
 * refusal they cannot act on.
 */
export function TaskFieldDialog({
    open,
    onOpenChange,
    field,
    isSubmitting,
    onSubmit,
}: TaskFieldDialogProps) {
    const isEditing = field !== null;

    const form = useForm<CreateTaskFieldInput>({
        resolver: zodResolver(CreateTaskFieldSchema),
        defaultValues: { label: "", field_type: "text" },
    });

    useEffect(() => {
        if (!open) return;
        form.reset({ label: field?.label ?? "", field_type: field?.field_type ?? "text" });
    }, [open, field, form]);

    const handleSubmit = form.handleSubmit(async (values) => {
        await onSubmit({ label: values.label.trim(), field_type: values.field_type });
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[95vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[500px]">
                <DialogHeader className="border-b px-6 pt-6 pb-4">
                    <DialogTitle className="line-clamp-1">
                        {isEditing ? "Edit column" : "Add column"}
                    </DialogTitle>
                    <DialogDescription>
                        {isEditing
                            ? "Rename this column. Every task keeps the answer it already stores."
                            : "Add a column to this department’s task list. Its type is fixed once it is created."}
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
                                            Column name <span className="text-destructive">*</span>
                                        </FormLabel>
                                        <FormControl>
                                            <Input placeholder="e.g. Client" autoComplete="off" {...formField} />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <FormField
                                control={form.control}
                                name="field_type"
                                render={({ field: formField }) => (
                                    <FormItem>
                                        <FormLabel>Type</FormLabel>
                                        <Select
                                            value={formField.value}
                                            onValueChange={formField.onChange}
                                            disabled={isEditing}
                                        >
                                            <FormControl>
                                                <SelectTrigger className="w-full">
                                                    <SelectValue placeholder="Choose a type" />
                                                </SelectTrigger>
                                            </FormControl>
                                            <SelectContent>
                                                {FIELD_TYPE_ORDER.map((type) => (
                                                    <SelectItem key={type} value={type}>
                                                        {fieldTypeLabel(type)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <FormDescription>
                                            {isEditing
                                                ? "The type is fixed after a column is created."
                                                : "A Choice column offers a list of options you define next."}
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
                                    "Add column"
                                )}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}
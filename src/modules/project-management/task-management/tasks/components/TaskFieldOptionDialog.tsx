"use client";

import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
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
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { TaskFieldColorSchema, TaskFieldIconSchema, TaskFieldLabelSchema } from "../types/task-field.schema";
import type { TaskFieldOption } from "../hooks/useTasks";
import { CatalogIconPicker } from "./CatalogIconPicker";

/** A valid 6-digit hex the native colour input can render before the user picks their own. */
const FALLBACK_HEX = "#64748b";

/**
 * The editable fields of one choice: its label, an optional colour, and whether it is the column's
 * default.
 *
 * `isDefault` is NOT a per-choice flag. A column owns exactly ONE `default_value` (the id of the
 * chosen option), so this boolean only records whether the choice being edited is the one that value
 * names. A per-choice flag alongside it would record the same fact twice and let the two disagree.
 */
const OptionFormSchema = z.object({
    label: TaskFieldLabelSchema,
    color: TaskFieldColorSchema.nullable(),
    icon: TaskFieldIconSchema.nullable(),
    isDefault: z.boolean(),
});

export type TaskFieldOptionFormInput = z.infer<typeof OptionFormSchema>;

export interface TaskFieldOptionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The choice being edited, or `null` when adding a new one. */
    option: TaskFieldOption | null;
    /** The label of the column this choice belongs to, so the copy can name it. */
    fieldLabel: string;
    /** Whether this choice is the column's current default, seeding the switch. */
    isDefault: boolean;
    isSubmitting: boolean;
    onSubmit: (values: TaskFieldOptionFormInput) => void | Promise<void>;
}

/**
 * The create/edit dialog for one choice of a `select` column — label, colour and default.
 *
 * The colour is collected here, alongside the label, rather than by a control under the row: a choice
 * is edited in one place, and the native picker and the hex text field write the same value. The
 * default switch writes the column's single `default_value`, the same fact the row's star writes.
 */
export function TaskFieldOptionDialog({
    open,
    onOpenChange,
    option,
    fieldLabel,
    isDefault,
    isSubmitting,
    onSubmit,
}: TaskFieldOptionDialogProps) {
    const isEditing = option !== null;

    const form = useForm<TaskFieldOptionFormInput>({
        resolver: zodResolver(OptionFormSchema),
        defaultValues: { label: "", color: null, icon: null, isDefault: false },
    });

    /** The live colour, so the icon previews below track it without subscribing via `form.watch`. */
    const currentColor = useWatch({ control: form.control, name: "color" });

    useEffect(() => {
        if (!open) return;
        form.reset({
            label: option?.label ?? "",
            color: option?.color ?? null,
            icon: option?.icon ?? null,
            isDefault,
        });
    }, [open, option, isDefault, form]);

    const handleSubmit = form.handleSubmit(async (values) => {
        await onSubmit({
            label: values.label.trim(),
            color: values.color ?? null,
            icon: values.icon ?? null,
            isDefault: values.isDefault === true,
        });
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
                            ? `Change the label, colour or default of this choice of “${fieldLabel}”. Tasks that already picked it follow immediately.`
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

                            <FormField
                                control={form.control}
                                name="color"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Colour</FormLabel>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="color"
                                                aria-label="Pick a colour for this choice"
                                                className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
                                                value={field.value ?? FALLBACK_HEX}
                                                onChange={(event) => field.onChange(event.target.value)}
                                            />
                                            <FormControl>
                                                <Input
                                                    placeholder="#16a34a"
                                                    autoComplete="off"
                                                    className="font-mono"
                                                    value={field.value ?? ""}
                                                    onChange={(event) => {
                                                        const next = event.target.value.trim();
                                                        field.onChange(next === "" ? null : next);
                                                    }}
                                                />
                                            </FormControl>
                                        </div>
                                        <FormDescription>
                                            Optional 6-digit hex, such as #16a34a. Shown as a badge tint.
                                        </FormDescription>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <FormField
                                control={form.control}
                                name="icon"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel htmlFor="task-field-option-icon">Icon</FormLabel>
                                        <CatalogIconPicker
                                            id="task-field-option-icon"
                                            value={field.value ?? null}
                                            onChange={field.onChange}
                                            color={currentColor}
                                            disabled={isSubmitting}
                                        />
                                        <FormDescription>
                                            Optional icon shown with this choice. Previews follow the colour above.
                                        </FormDescription>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <FormField
                                control={form.control}
                                name="isDefault"
                                render={({ field }) => (
                                    <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
                                        <div className="space-y-0.5">
                                            <FormLabel>Make this the default choice</FormLabel>
                                            <FormDescription>
                                                New tasks that omit this column use this choice.
                                            </FormDescription>
                                        </div>
                                        <FormControl>
                                            <Switch
                                                checked={field.value === true}
                                                onCheckedChange={field.onChange}
                                                aria-label="Make this the default choice"
                                            />
                                        </FormControl>
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

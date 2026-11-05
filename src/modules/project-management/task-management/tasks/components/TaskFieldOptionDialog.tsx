"use client";

import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch, type ControllerRenderProps } from "react-hook-form";
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

/** The choice completion field's helper copy — the one place the 0 and 100 ends are explained. */
const COMPLETION_DESCRIPTION =
    "How complete a task is when it carries this choice. 0 means not started, 100 means done.";

/**
 * The whole 0-100 value behind whatever the text field handed over.
 *
 * The resolver would reject `101`, `""` and `NaN` with a message the user cannot act on, so the value
 * is repaired before it reaches it: an unusable or empty field reads as 0 (nothing scored), and
 * anything outside the range is clamped instead of accepted.
 */
function clampCompletionPercent(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(100, Math.max(0, Math.round(parsed)));
}

/**
 * The editable fields of one choice: its label, an optional colour, how complete carrying it counts
 * as, and whether it is the column's default.
 *
 * `isDefault` is NOT a per-choice flag. A column owns exactly ONE `default_value` (the id of the
 * chosen option), so this boolean only records whether the choice being edited is the one that value
 * names. A per-choice flag alongside it would record the same fact twice and let the two disagree.
 */
const OptionFormSchema = z.object({
    label: TaskFieldLabelSchema,
    color: TaskFieldColorSchema.nullable(),
    icon: TaskFieldIconSchema.nullable(),
    // Same 0-100 rule the option schemas on the wire use (`CompletionPercentSchema` in
    // `../types/task-field.schema`): the clamp above keeps this unreachable, so the message is a guard
    // for a caller that bypassed the box rather than something a user should ever see.
    completion_percent: z.number().int().min(0).max(100),
    isDefault: z.boolean(),
});

export type TaskFieldOptionFormInput = z.infer<typeof OptionFormSchema>;

interface CompletionInputProps {
    field: ControllerRenderProps<TaskFieldOptionFormInput, "completion_percent">;
    /** The choice's stored value. Read once at mount, before the dialog's form reset has run. */
    initialPercent: number;
}

/**
 * The completion box, holding its own text so the field can sit empty while the user retypes.
 *
 * The form only ever stores a whole 0-100, so an empty box is not expressible there; the text is kept
 * here and the form is driven to 0 while the box is empty. Radix unmounts the dialog body on close,
 * so every open mounts this again with the choice's saved value.
 */
function CompletionInput({ field, initialPercent }: CompletionInputProps) {
    const [text, setText] = useState(() => String(initialPercent));

    return (
        <FormControl>
            <Input
                inputMode="numeric"
                autoComplete="off"
                className="pr-8 tabular-nums"
                // Spread first so RHF's ref and name survive; the handlers below replace its value wiring.
                {...field}
                value={text}
                onChange={(event) => {
                    const digits = event.target.value.replace(/[^0-9]/g, "").slice(0, 3);
                    if (digits === "") {
                        setText("");
                        field.onChange(0);
                        return;
                    }
                    const next = clampCompletionPercent(digits);
                    setText(String(next));
                    field.onChange(next);
                }}
                onBlur={() => {
                    setText(String(clampCompletionPercent(field.value)));
                    field.onBlur();
                }}
            />
        </FormControl>
    );
}

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
 * The create/edit dialog for one choice of a `select` column — label, colour, completion and default.
 *
 * The colour is collected here, alongside the label, rather than by a control under the row: a choice
 * is edited in one place, and the native picker and the hex text field write the same value. The
 * default switch writes the column's single `default_value`, the same fact the row's star writes.
 *
 * Only a `select` column has choices at all, and this dialog is opened from that branch of
 * `TaskFieldsSection`, so the completion weight needs no type gate here: a `text` or `number` column
 * never reaches it.
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
        defaultValues: { label: "", color: null, icon: null, completion_percent: 0, isDefault: false },
    });

    /** The live colour, so the icon previews below track it without subscribing via `form.watch`. */
    const currentColor = useWatch({ control: form.control, name: "color" });

    useEffect(() => {
        if (!open) return;
        form.reset({
            label: option?.label ?? "",
            color: option?.color ?? null,
            icon: option?.icon ?? null,
            completion_percent: clampCompletionPercent(option?.completion_percent),
            isDefault,
        });
    }, [open, option, isDefault, form]);

    const handleSubmit = form.handleSubmit(async (values) => {
        await onSubmit({
            label: values.label.trim(),
            color: values.color ?? null,
            icon: values.icon ?? null,
            completion_percent: clampCompletionPercent(values.completion_percent),
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
                            ? `Change the label, completion, colour or default of this choice of “${fieldLabel}”. Tasks that already picked it follow immediately.`
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
                                name="completion_percent"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Completion</FormLabel>
                                        <div className="relative">
                                            <CompletionInput
                                                field={field}
                                                initialPercent={clampCompletionPercent(option?.completion_percent)}
                                            />
                                            <span
                                                aria-hidden="true"
                                                className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
                                            >
                                                %
                                            </span>
                                        </div>
                                        <FormDescription>{COMPLETION_DESCRIPTION}</FormDescription>
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

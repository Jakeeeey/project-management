"use client";

import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch, type ControllerRenderProps } from "react-hook-form";
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
import { Switch } from "@/components/ui/switch";

import {
    CreateCatalogItemSchema,
    type CatalogKind,
    type CreateCatalogItemInput,
} from "../types/task-config.schema";
import { kindLabel, type CatalogFormInput, type CatalogItem } from "../hooks/useTaskConfiguration";
import { CatalogIconPicker } from "../../tasks/components/CatalogIconPicker";

/** A valid 6-digit hex the native colour input can render before the user picks their own. */
const FALLBACK_HEX = "#64748b";

/** The status completion field's helper copy — the one place the 0 and 100 ends are explained. */
const COMPLETION_DESCRIPTION =
    "How complete a task in this status is. 0 means not started, 100 means done.";

/**
 * The whole 0-100 value behind whatever the text field handed over.
 *
 * The resolver would reject `101`, `""` and `NaN` with a message the user cannot act on, so the
 * value is repaired before it reaches it: an unusable or empty field reads as 0 (the column's own
 * default), and anything outside the range is clamped instead of accepted.
 */
function clampCompletionPercent(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(100, Math.max(0, Math.round(parsed)));
}

interface CompletionInputProps {
    field: ControllerRenderProps<CreateCatalogItemInput, "completion_percent">;
    /** The row's stored value. Read once at mount, before the dialog's form reset has run. */
    initialPercent: number;
}

/**
 * The completion box, holding its own text so the field can sit empty while the user retypes.
 *
 * The form only ever stores a whole 0-100, so an empty box is not expressible there; the text is
 * kept here and the form is driven to 0 while the box is empty. Radix unmounts the dialog body on
 * close, so every open mounts this again with the row's saved value.
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

export interface CatalogItemDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    kind: CatalogKind;
    /** The row being edited, or `null` when adding a new one. */
    item: CatalogItem | null;
    /** True while any catalog mutation is in flight — gates both footer buttons. */
    isSubmitting: boolean;
    onSubmit: (values: CatalogFormInput) => void | Promise<void>;
}

/**
 * The create/edit dialog for one status or priority.
 *
 * Width is the QA checklist's `S` tier (`sm:max-w-[500px]`) plus `w-[95vw]` so it always fits a
 * phone; the body scrolls inside a capped `max-h` while the header and footer stay pinned. Cancel
 * comes before Submit, and Submit carries a `disabled` gate for the whole in-flight window.
 *
 * The colour field is a plain 6-digit hex: the native picker and the text input write the same
 * value, and it is stored as data and applied later as an inline style — never as a Tailwind class.
 */
export function CatalogItemDialog({
    open,
    onOpenChange,
    kind,
    item,
    isSubmitting,
    onSubmit,
}: CatalogItemDialogProps) {
    const label = kindLabel(kind);
    const isEditing = item !== null;

    const form = useForm<CreateCatalogItemInput>({
        resolver: zodResolver(CreateCatalogItemSchema),
        defaultValues: { label: "", color: null, icon: null, is_default: false, completion_percent: 0 },
    });

    /** The live colour, so the icon previews below track it without subscribing via `form.watch`. */
    const currentColor = useWatch({ control: form.control, name: "color" });

    useEffect(() => {
        if (!open) return;
        form.reset({
            label: item?.label ?? "",
            color: item?.color ?? null,
            icon: item?.icon ?? null,
            is_default: item?.is_default ?? false,
            completion_percent: clampCompletionPercent(item?.completion_percent),
        });
    }, [open, item, form]);

    const handleSubmit = form.handleSubmit(async (values) => {
        await onSubmit({
            label: values.label.trim(),
            color: values.color ?? null,
            icon: values.icon ?? null,
            is_default: values.is_default === true,
            // A priority has no such column, so nothing is sent for it — not even the default 0.
            ...(kind === "status"
                ? { completion_percent: clampCompletionPercent(values.completion_percent) }
                : {}),
        });
    });

    const description = isEditing
        ? `Change the label, ${kind === "status" ? "completion, " : ""}colour or default flag. Every task already pointing at this row follows immediately.`
        : `Add a new ${kind} to this department’s list. Tasks reference these rows directly.`;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[95vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[500px]">
                <DialogHeader className="border-b px-6 pt-6 pb-4">
                    <DialogTitle className="line-clamp-1">
                        {isEditing ? `Edit ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`}
                    </DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>

                <Form {...form}>
                    <form onSubmit={handleSubmit} className="flex flex-col">
                        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-6 py-4">
                            <FormField
                                control={form.control}
                                name="label"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>
                                            Label <span className="text-destructive">*</span>
                                        </FormLabel>
                                        <FormControl>
                                            <Input
                                                placeholder={kind === "status" ? "e.g. In review" : "e.g. High"}
                                                autoComplete="off"
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            {/* Statuses carry a completion percentage; a priority has no such column,
                                so the control is absent rather than disabled. */}
                            {kind === "status" ? (
                                <FormField
                                    control={form.control}
                                    name="completion_percent"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Completion</FormLabel>
                                            <div className="relative">
                                                <CompletionInput
                                                    field={field}
                                                    initialPercent={clampCompletionPercent(item?.completion_percent)}
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
                            ) : null}

                            <FormField
                                control={form.control}
                                name="color"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Colour</FormLabel>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="color"
                                                aria-label={`Pick a colour for this ${kind}`}
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
                                        <FormLabel htmlFor="catalog-item-icon">Icon</FormLabel>
                                        {/*
                                         * The picker previews every glyph in the colour being chosen
                                         * above, so `form.watch("color")` is read here rather than
                                         * duplicating the colour into a second form field.
                                         */}
                                        <CatalogIconPicker
                                            id="catalog-item-icon"
                                            value={field.value ?? null}
                                            onChange={field.onChange}
                                            color={currentColor}
                                            disabled={isSubmitting}
                                        />
                                        <FormDescription>
                                            Optional icon shown with the badge. Previews follow the colour above.
                                        </FormDescription>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <FormField
                                control={form.control}
                                name="is_default"
                                render={({ field }) => (
                                    <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
                                        <div className="space-y-0.5">
                                            <FormLabel>Make this the default {kind}</FormLabel>
                                            <FormDescription>
                                                New tasks that omit a {kind} use this row.
                                            </FormDescription>
                                        </div>
                                        <FormControl>
                                            <Switch
                                                checked={field.value === true}
                                                onCheckedChange={field.onChange}
                                                aria-label={`Make this the default ${kind}`}
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
                                    `Add ${kind}`
                                )}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}

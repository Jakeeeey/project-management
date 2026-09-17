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
import { Switch } from "@/components/ui/switch";

import {
    CreateCatalogItemSchema,
    type CatalogKind,
    type CreateCatalogItemInput,
} from "../types/task-config.schema";
import { kindLabel, type CatalogFormInput, type CatalogItem } from "../hooks/useTaskConfiguration";

/** A valid 6-digit hex the native colour input can render before the user picks their own. */
const FALLBACK_HEX = "#64748b";

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
        defaultValues: { label: "", color: null, is_default: false },
    });

    useEffect(() => {
        if (!open) return;
        form.reset({
            label: item?.label ?? "",
            color: item?.color ?? null,
            is_default: item?.is_default ?? false,
        });
    }, [open, item, form]);

    const handleSubmit = form.handleSubmit(async (values) => {
        await onSubmit({
            label: values.label.trim(),
            color: values.color ?? null,
            is_default: values.is_default === true,
        });
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[95vw] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[500px]">
                <DialogHeader className="border-b px-6 pt-6 pb-4">
                    <DialogTitle className="line-clamp-1">
                        {isEditing ? `Edit ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`}
                    </DialogTitle>
                    <DialogDescription>
                        {isEditing
                            ? "Change the label, colour or default flag. Every task already pointing at this row follows immediately."
                            : `Add a new ${kind} to this department’s list. Tasks reference these rows directly.`}
                    </DialogDescription>
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

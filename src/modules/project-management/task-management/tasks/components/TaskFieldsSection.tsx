"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { fieldTypeLabel, useTaskFields, type TaskFieldFormInput } from "../hooks/useTaskFields";
import type { TaskField, TaskFieldOption } from "../hooks/useTasks";
import { TaskFieldDialog } from "./TaskFieldDialog";
import { TaskFieldOptionDialog } from "./TaskFieldOptionDialog";

/** Which column the column-dialog is editing, or `null` when it is closed. */
interface FieldEditorState {
    readonly field: TaskField | null;
}

/** Which choice of which column the choice-dialog is editing, or `null` when it is closed. */
interface OptionEditorState {
    readonly field: TaskField;
    readonly option: TaskFieldOption | null;
}

/** The row a delete confirmation is currently holding. */
interface PendingDelete {
    readonly kind: "field" | "option";
    readonly id: number;
    readonly label: string;
    readonly parentLabel: string;
}

/**
 * The Custom fields section of the existing Settings page.
 *
 * The section is a SECTION, not a page: there is no route and no sidebar entry for it, because the
 * parent `/project-management` module already authorizes `/project-management/task-management/configure`.
 *
 * It renders nothing at all — not a disabled form, not a lock message — unless the server said
 * `capabilities.canConfigure`. That flag is read from the custom-fields route and never derived
 * here, so a plain member has no way to reach a column write and never sees the section in the DOM.
 *
 * A `select` column owns its choices, so the choices editor is nested inside the column it belongs
 * to rather than living in a flat list: there is no such thing as a choice without a column.
 */
export function TaskFieldsSection() {
    const {
        fields,
        isLoading,
        isSubmitting,
        error,
        capabilities,
        refresh,
        createField,
        renameField,
        deleteField,
        createOption,
        renameOption,
        deleteOption,
    } = useTaskFields();

    const [fieldEditor, setFieldEditor] = useState<FieldEditorState | null>(null);
    const [optionEditor, setOptionEditor] = useState<OptionEditorState | null>(null);
    const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

    if (capabilities?.canConfigure !== true) return null;

    const handleFieldSubmit = async (values: TaskFieldFormInput) => {
        if (fieldEditor === null) return;
        const saved =
            fieldEditor.field === null
                ? await createField(values)
                : await renameField(fieldEditor.field.id, values.label);
        if (saved) setFieldEditor(null);
    };

    const handleOptionSubmit = async (label: string) => {
        if (optionEditor === null) return;
        const saved =
            optionEditor.option === null
                ? await createOption(optionEditor.field.id, label)
                : await renameOption(optionEditor.option.id, label);
        if (saved) setOptionEditor(null);
    };

    const handleConfirmDelete = async () => {
        if (pendingDelete === null) return;
        const removed =
            pendingDelete.kind === "field"
                ? await deleteField(pendingDelete.id, pendingDelete.label)
                : await deleteOption(pendingDelete.id, pendingDelete.label);
        if (removed) setPendingDelete(null);
    };

    return (
        <section
            data-slot="task-fields-section"
            className="mx-auto w-full max-w-3xl scroll-pt-16 px-4 pb-10 md:scroll-pt-20"
        >
            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1.5">
                            <CardTitle>Custom fields</CardTitle>
                            <CardDescription>
                                Add your own columns to the task list. A Choice column offers the options you
                                define, and every task stores its own answer.
                            </CardDescription>
                        </div>
                        <Button
                            type="button"
                            onClick={() => setFieldEditor({ field: null })}
                            disabled={isSubmitting}
                            className="min-h-11 shrink-0 md:min-h-0"
                        >
                            <Plus className="size-4" aria-hidden="true" />
                            Add column
                        </Button>
                    </div>
                </CardHeader>

                <CardContent className="space-y-4">
                    {error ? (
                        <Alert variant="destructive">
                            <AlertTriangle className="size-4" aria-hidden="true" />
                            <AlertTitle>Custom fields error</AlertTitle>
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}

                    {isLoading ? (
                        <div className="space-y-3" aria-hidden="true">
                            <Skeleton className="h-16 w-full" />
                            <Skeleton className="h-16 w-full" />
                        </div>
                    ) : fields.length === 0 ? (
                        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                            No custom columns yet. Add one and it appears on the task list straight away.
                        </p>
                    ) : (
                        <ul className="space-y-3">
                            {fields.map((field) => (
                                <li key={field.id} className="rounded-lg border p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className="truncate text-sm font-medium">{field.label}</span>
                                            <Badge variant="secondary">{fieldTypeLabel(field.field_type)}</Badge>
                                        </div>

                                        <div className="flex items-center gap-1">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`Rename the column ${field.label}`}
                                                title={`Rename ${field.label}`}
                                                disabled={isSubmitting}
                                                onClick={() => setFieldEditor({ field })}
                                            >
                                                <Pencil className="size-4" aria-hidden="true" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`Remove the column ${field.label}`}
                                                title={`Remove ${field.label}`}
                                                disabled={isSubmitting}
                                                onClick={() =>
                                                    setPendingDelete({
                                                        kind: "field",
                                                        id: field.id,
                                                        label: field.label,
                                                        parentLabel: field.label,
                                                    })
                                                }
                                            >
                                                <Trash2 className="size-4" aria-hidden="true" />
                                            </Button>
                                        </div>
                                    </div>

                                    {field.field_type === "select" ? (
                                        <div className="mt-3 space-y-2 border-t pt-3">
                                            {field.options.length === 0 ? (
                                                <p className="text-xs text-muted-foreground">
                                                    No choices yet. A Choice column with no choices stores nothing.
                                                </p>
                                            ) : (
                                                <ul className="flex flex-wrap gap-2">
                                                    {field.options.map((option) => (
                                                        <li key={option.id}>
                                                            <span className="inline-flex items-center gap-1 rounded-full border bg-muted/40 py-1 pr-1 pl-3 text-xs">
                                                                <span className="max-w-[16rem] truncate">{option.label}</span>
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="icon-sm"
                                                                    className="size-6"
                                                                    aria-label={`Rename the choice ${option.label} of ${field.label}`}
                                                                    title={`Rename ${option.label}`}
                                                                    disabled={isSubmitting}
                                                                    onClick={() => setOptionEditor({ field, option })}
                                                                >
                                                                    <Pencil className="size-3.5" aria-hidden="true" />
                                                                </Button>
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="icon-sm"
                                                                    className="size-6"
                                                                    aria-label={`Remove the choice ${option.label} of ${field.label}`}
                                                                    title={`Remove ${option.label}`}
                                                                    disabled={isSubmitting}
                                                                    onClick={() =>
                                                                        setPendingDelete({
                                                                            kind: "option",
                                                                            id: option.id,
                                                                            label: option.label,
                                                                            parentLabel: field.label,
                                                                        })
                                                                    }
                                                                >
                                                                    <Trash2 className="size-3.5" aria-hidden="true" />
                                                                </Button>
                                                            </span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}

                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                disabled={isSubmitting}
                                                onClick={() => setOptionEditor({ field, option: null })}
                                            >
                                                <Plus className="size-4" aria-hidden="true" />
                                                Add choice
                                            </Button>
                                        </div>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className="flex justify-end">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                void refresh();
                            }}
                            disabled={isLoading || isSubmitting}
                            className="min-h-11 md:min-h-0"
                        >
                            {isLoading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                            Refresh
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <TaskFieldDialog
                key={fieldEditor === null ? "task-field-dialog" : `field-${fieldEditor.field?.id ?? "new"}`}
                open={fieldEditor !== null}
                onOpenChange={(open) => {
                    if (!open) setFieldEditor(null);
                }}
                field={fieldEditor?.field ?? null}
                isSubmitting={isSubmitting}
                onSubmit={handleFieldSubmit}
            />

            <TaskFieldOptionDialog
                key={
                    optionEditor === null
                        ? "task-field-option-dialog"
                        : `option-${optionEditor.option?.id ?? "new"}-${optionEditor.field.id}`
                }
                open={optionEditor !== null}
                onOpenChange={(open) => {
                    if (!open) setOptionEditor(null);
                }}
                option={optionEditor?.option ?? null}
                fieldLabel={optionEditor?.field.label ?? ""}
                isSubmitting={isSubmitting}
                onSubmit={handleOptionSubmit}
            />

            <AlertDialog
                open={pendingDelete !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingDelete(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {pendingDelete?.kind === "option" ? "Remove this choice?" : "Remove this column?"}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {pendingDelete === null
                                ? ""
                                : pendingDelete.kind === "option"
                                  ? `“${pendingDelete.label}” leaves the picker for “${pendingDelete.parentLabel}”. Tasks that already picked it keep the answer and show a removed-choice placeholder.`
                                  : `“${pendingDelete.label}” leaves the task list, along with its choices. Every answer already stored is kept, so adding the column back restores them.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={isSubmitting}
                            onClick={() => {
                                void handleConfirmDelete();
                            }}
                        >
                            {pendingDelete?.kind === "option" ? "Remove choice" : "Remove column"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}
"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronRight, EyeOff, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";

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
import { Switch } from "@/components/ui/switch";
import {
    Pagination,
    PaginationContent,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from "@/components/ui/pagination";
import { CatalogChip } from "@/modules/project-management/components/CatalogChip";

import { fieldTypeLabel, useTaskFields, type TaskFieldFormInput } from "../hooks/useTaskFields";
import type { TaskField, TaskFieldOption } from "../hooks/useTasks";
import { TaskFieldDefaultValueEditor } from "./TaskFieldDefaultValueEditor";
import { TaskFieldDialog } from "./TaskFieldDialog";
import { TaskFieldOptionColorPicker } from "./TaskFieldOptionColorPicker";
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
/**
 * Columns per page.
 *
 * Ten collapsed rows is roughly one viewport, so the section's height stops depending on how many
 * columns a department owns. Without a cap, a department with 20 columns and 80 choices rendered an
 * 11,757px scroll.
 */
const PAGE_SIZE = 10;

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
        setEnabled,
        setDefaultValue,
        createOption,
        renameOption,
        setOptionColor,
        deleteOption,
    } = useTaskFields();

    const [fieldEditor, setFieldEditor] = useState<FieldEditorState | null>(null);
    const [optionEditor, setOptionEditor] = useState<OptionEditorState | null>(null);
    const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

    /**
     * One column expanded at a time (an accordion), and one page of columns at a time.
     *
     * Together these are what make the section scale: every column's default editor and choice list
     * render ONLY while that column is expanded, so the height is bounded by `PAGE_SIZE` rather than
     * by how many columns exist. Expanding is a deliberate act, so the column being edited stays
     * open across a refetch — the expanded id is a real id, not an index.
     */
    const [expandedFieldId, setExpandedFieldId] = useState<number | null>(null);
    const [page, setPage] = useState(1);

    const totalPages = Math.max(1, Math.ceil(fields.length / PAGE_SIZE));
    // Clamp: removing columns can leave the current page past the end.
    const currentPage = Math.min(page, totalPages);
    const pagedFields = fields.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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
                ? await createOption(optionEditor.field.id, label, null)
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
                        <ul className="space-y-2">
                            {pagedFields.map((field) => {
                                const isExpanded = expandedFieldId === field.id;
                                const choiceCount = field.options.length;

                                return (
                                    <li
                                        key={field.id}
                                        data-slot="task-field-row"
                                        data-expanded={isExpanded}
                                        className={cn(
                                            "rounded-lg border",
                                            field.is_enabled ? undefined : "opacity-60",
                                        )}
                                    >
                                        <div className="flex flex-wrap items-center gap-2 p-2">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-expanded={isExpanded}
                                                aria-label={
                                                    isExpanded
                                                        ? `Collapse ${field.label}`
                                                        : `Edit ${field.label}`
                                                }
                                                title={isExpanded ? "Collapse" : "Edit this column"}
                                                data-slot="task-field-expand"
                                                onClick={() => setExpandedFieldId(isExpanded ? null : field.id)}
                                                className="shrink-0 text-muted-foreground hover:text-foreground"
                                            >
                                                <ChevronRight
                                                    className={cn(
                                                        "size-4 transition-transform",
                                                        isExpanded && "rotate-90",
                                                    )}
                                                    aria-hidden="true"
                                                />
                                            </Button>

                                            <Switch
                                                checked={field.is_enabled}
                                                disabled={isSubmitting}
                                                aria-label={
                                                    field.is_enabled
                                                        ? `Hide ${field.label}`
                                                        : `Show ${field.label}`
                                                }
                                                title={
                                                    field.is_enabled
                                                        ? `Hide ${field.label}`
                                                        : `Show ${field.label}`
                                                }
                                                onCheckedChange={(next) => {
                                                    void setEnabled(field.id, next);
                                                }}
                                            />
                                            <span className="min-w-0 truncate text-sm font-medium">{field.label}</span>
                                            <Badge variant="secondary">{fieldTypeLabel(field.field_type)}</Badge>

                                            {field.field_type === "select" ? (
                                                <span className="text-xs text-muted-foreground">
                                                    {choiceCount} choice{choiceCount === 1 ? "" : "s"}
                                                </span>
                                            ) : null}

                                            {field.is_enabled ? null : (
                                                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                                    <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
                                                    Hidden
                                                </span>
                                            )}

                                            <div className="ml-auto flex items-center gap-1">
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

                                        {isExpanded ? (
                                            <>
                                                {field.is_enabled ? null : (
                                        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                            <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
                                            Hidden from the task list and the form. Every stored answer is kept.
                                        </p>
                                    )}

                                    <div className="mt-3 flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                        <div className="min-w-0">
                                            <p className="text-xs font-medium">Default value</p>
                                            <p className="text-xs text-muted-foreground">
                                                Applies to new tasks only.
                                            </p>
                                        </div>
                                        <div className="w-full shrink-0 sm:w-64">
                                            <TaskFieldDefaultValueEditor
                                                key={`${field.id}:${field.default_value ?? ""}`}
                                                field={field}
                                                disabled={isSubmitting}
                                                onCommit={(value) => {
                                                    void setDefaultValue(field.id, value);
                                                }}
                                            />
                                        </div>
                                    </div>

                                    {field.field_type === "select" ? (
                                        <div className="mt-3 space-y-2 border-t pt-3">
                                            {field.options.length === 0 ? (
                                                <p className="text-xs text-muted-foreground">
                                                    No choices yet. A Choice column with no choices stores nothing.
                                                </p>
                                            ) : (
                                                <ul className="space-y-2">
                                                    {field.options.map((option) => (
                                                        <li
                                                            key={option.id}
                                                            className="rounded-md border bg-muted/20 p-2"
                                                        >
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <CatalogChip
                                                                    value={{
                                                                        label: option.label,
                                                                        color: option.color,
                                                                    }}
                                                                    density="comfortable"
                                                                    className="max-w-[16rem]"
                                                                />
                                                                {String(option.id) === field.default_value ? (
                                                                    <Badge variant="secondary" className="gap-1">
                                                                        <Check
                                                                            className="size-3"
                                                                            aria-hidden="true"
                                                                        />
                                                                        Default
                                                                    </Badge>
                                                                ) : null}
                                                                <div className="ml-auto flex items-center gap-1">
                                                                    <Button
                                                                        type="button"
                                                                        variant="ghost"
                                                                        size="icon-sm"
                                                                        className="size-6"
                                                                        aria-label={`Rename the choice ${option.label} of ${field.label}`}
                                                                        title={`Rename ${option.label}`}
                                                                        disabled={isSubmitting}
                                                                        onClick={() =>
                                                                            setOptionEditor({ field, option })
                                                                        }
                                                                    >
                                                                        <Pencil
                                                                            className="size-3.5"
                                                                            aria-hidden="true"
                                                                        />
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
                                                                        <Trash2
                                                                            className="size-3.5"
                                                                            aria-hidden="true"
                                                                        />
                                                                    </Button>
                                                                </div>
                                                            </div>

                                                            <div className="mt-2">
                                                                <TaskFieldOptionColorPicker
                                                                    key={`${option.id}:${option.color ?? ""}`}
                                                                    optionLabel={option.label}
                                                                    fieldLabel={field.label}
                                                                    color={option.color}
                                                                    disabled={isSubmitting}
                                                                    onChange={(color) => {
                                                                        void setOptionColor(option.id, color);
                                                                    }}
                                                                />
                                                            </div>
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
                                            </>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {/* Pagination bounds the section's height the same way the collapse does: the
                        number of rows on screen is `PAGE_SIZE`, never `fields.length`. It renders
                        nothing on a single page, so a small department never sees a pager. */}
                    {totalPages > 1 ? (
                        <div className="flex flex-col items-center justify-between gap-3 border-t pt-3 sm:flex-row">
                            <p className="text-xs text-muted-foreground">
                                Page {currentPage} of {totalPages}
                                {" · "}
                                {fields.length} column{fields.length === 1 ? "" : "s"}
                            </p>

                            <Pagination className="mx-0 w-auto">
                                <PaginationContent>
                                    <PaginationItem>
                                        <PaginationPrevious
                                            href="#"
                                            aria-label="Previous page of columns"
                                            aria-disabled={currentPage <= 1}
                                            className={
                                                currentPage <= 1 ? "pointer-events-none opacity-50" : undefined
                                            }
                                            onClick={(event) => {
                                                event.preventDefault();
                                                setPage(Math.max(1, currentPage - 1));
                                                setExpandedFieldId(null);
                                            }}
                                        />
                                    </PaginationItem>
                                    <PaginationItem>
                                        <PaginationLink
                                            href="#"
                                            isActive
                                            aria-label={`Page ${currentPage} of ${totalPages}`}
                                            onClick={(event) => event.preventDefault()}
                                        >
                                            {currentPage}
                                        </PaginationLink>
                                    </PaginationItem>
                                    <PaginationItem>
                                        <PaginationNext
                                            href="#"
                                            aria-label="Next page of columns"
                                            aria-disabled={currentPage >= totalPages}
                                            className={
                                                currentPage >= totalPages
                                                    ? "pointer-events-none opacity-50"
                                                    : undefined
                                            }
                                            onClick={(event) => {
                                                event.preventDefault();
                                                setPage(Math.min(totalPages, currentPage + 1));
                                                setExpandedFieldId(null);
                                            }}
                                        />
                                    </PaginationItem>
                                </PaginationContent>
                            </Pagination>
                        </div>
                    ) : null}

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
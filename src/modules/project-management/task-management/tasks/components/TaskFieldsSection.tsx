"use client";

import { useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronRight, EyeOff, Loader2, Pencil, Plus, Star, Trash2 } from "lucide-react";

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
import { CatalogChip } from "./CatalogChip";

import { fieldTypeLabel, useTaskFields, type TaskFieldFormInput } from "../hooks/useTaskFields";
import type { TaskField, TaskFieldOption } from "../hooks/useTasks";
import { TaskFieldDialog } from "./TaskFieldDialog";
import { TaskFieldOptionDialog, type TaskFieldOptionFormInput } from "./TaskFieldOptionDialog";

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
        setOptionIcon,
        deleteOption,
        moveOption,
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

    /**
     * Saves one choice from the dialog.
     *
     * The column, not the choice, owns the default: `default_value` names ONE option, so the switch
     * is a per-choice view of that single fact — the same fact the row's star writes. Turning it ON
     * moves the default here; turning it OFF clears the default only when this choice WAS the
     * default, so editing some other choice can never wipe the column's default by accident.
     */
    const handleOptionSubmit = async (values: TaskFieldOptionFormInput) => {
        if (optionEditor === null) return;
        const { field, option } = optionEditor;

        if (option === null) {
            const createdId = await createOption(field.id, values.label, values.color, values.icon);
            if (createdId === null) return;
            // The create request carries the colour but the route does not persist it, so a non-null
            // colour is written through the same recolour path an edit uses.
            if (values.color !== null) {
                const coloured = await setOptionColor(createdId, values.color);
                if (!coloured) return;
            }
            if (values.isDefault) {
                const set = await setDefaultValue(field.id, String(createdId));
                if (!set) return;
            }
        } else {
            if (values.label !== option.label) {
                const renamed = await renameOption(option.id, values.label);
                if (!renamed) return;
            }
            if (values.color !== option.color) {
                const coloured = await setOptionColor(option.id, values.color);
                if (!coloured) return;
            }
            if ((values.icon ?? null) !== (option.icon ?? null)) {
                const iconned = await setOptionIcon(option.id, values.icon ?? null);
                if (!iconned) return;
            }
            if (values.isDefault) {
                if (String(option.id) !== field.default_value) {
                    const set = await setDefaultValue(field.id, String(option.id));
                    if (!set) return;
                }
            } else if (String(option.id) === field.default_value) {
                const cleared = await setDefaultValue(field.id, null);
                if (!cleared) return;
            }
        }

        setOptionEditor(null);
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
                        <ul
                            data-slot="task-field-list"
                            className="divide-y divide-border overflow-hidden rounded-lg border"
                        >
                            {pagedFields.map((field) => {
                                const isExpanded = expandedFieldId === field.id;
                                const choiceCount = field.options.length;

                                return (
                                    <li
                                        key={field.id}
                                        data-slot="task-field-row"
                                        data-expanded={isExpanded}
                                        className={cn(field.is_enabled ? undefined : "opacity-60")}
                                    >
                                        <div className="flex items-center gap-2 px-3 py-2">
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

                                            <div className="min-w-0 flex-1">
                                                <CatalogChip
                                                    value={{ label: field.label, color: null }}
                                                    density="comfortable"
                                                    className="max-w-full"
                                                    data-slot="task-field-chip"
                                                />
                                            </div>

                                            <Badge variant="secondary" className="shrink-0 text-[11px]">
                                                {fieldTypeLabel(field.field_type)}
                                            </Badge>

                                            {field.field_type === "select" ? (
                                                <span className="shrink-0 text-xs text-muted-foreground">
                                                    {choiceCount} choice{choiceCount === 1 ? "" : "s"}
                                                </span>
                                            ) : null}

                                            {field.is_enabled ? null : (
                                                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                                    <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
                                                    Hidden
                                                </span>
                                            )}

                                            <div className="flex shrink-0 items-center gap-0.5">
                                                <Switch
                                                    checked={field.is_enabled}
                                                    disabled={isSubmitting}
                                                    className="mx-1"
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
                                            <div className="space-y-3 border-t px-3 pb-3 pt-3">
                                                {field.is_enabled ? null : (
                                        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                            <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
                                            Hidden from the task list and the form. Every stored answer is kept.
                                        </p>
                                    )}

                                    {field.field_type === "select" ? (
                                        <div className="space-y-2">
                                            {field.options.length === 0 ? (
                                                <p className="text-xs text-muted-foreground">
                                                    No choices yet. A Choice column with no choices stores nothing.
                                                </p>
                                            ) : (
                                                <ul className="divide-y divide-border overflow-hidden rounded-lg border">
                                                    {field.options.map((option, index) => {
                                                        const isDefault =
                                                            String(option.id) === field.default_value;

                                                        return (
                                                            <li key={option.id} className="px-3 py-2">
                                                                <div className="flex items-center gap-2">
                                                                    <div className="min-w-0 flex-1">
                                                                        <CatalogChip
                                                                            value={{
                                                                                // The stored icon rides through so the settings list shows the same
                                                                                // glyph the task row and the pickers do; `CatalogChip` owns the
                                                                                // fallback, so a null icon still draws the default marker.
                                                                                label: option.label,
                                                                                color: option.color,
                                                                                icon: option.icon,
                                                                            }}
                                                                            density="comfortable"
                                                                            className="max-w-full"
                                                                        />
                                                                    </div>

                                                                    {isDefault ? (
                                                                        <Badge
                                                                            variant="secondary"
                                                                            className="shrink-0 text-[11px]"
                                                                        >
                                                                            Default
                                                                        </Badge>
                                                                    ) : null}

                                                                    <div className="flex shrink-0 items-center gap-0.5">
                                                                        <Button
                                                                            type="button"
                                                                            variant="ghost"
                                                                            size="icon-sm"
                                                                            onClick={() => {
                                                                                void moveOption(
                                                                                    field.id,
                                                                                    option.id,
                                                                                    "up",
                                                                                );
                                                                            }}
                                                                            disabled={isSubmitting || index === 0}
                                                                            aria-label={`Move ${option.label} up`}
                                                                            title={
                                                                                index === 0
                                                                                    ? "Already first"
                                                                                    : `Move ${option.label} up`
                                                                            }
                                                                        >
                                                                            <ArrowUp
                                                                                className="size-4"
                                                                                aria-hidden="true"
                                                                            />
                                                                        </Button>
                                                                        <Button
                                                                            type="button"
                                                                            variant="ghost"
                                                                            size="icon-sm"
                                                                            onClick={() => {
                                                                                void moveOption(
                                                                                    field.id,
                                                                                    option.id,
                                                                                    "down",
                                                                                );
                                                                            }}
                                                                            disabled={
                                                                                isSubmitting ||
                                                                                index === field.options.length - 1
                                                                            }
                                                                            aria-label={`Move ${option.label} down`}
                                                                            title={
                                                                                index === field.options.length - 1
                                                                                    ? "Already last"
                                                                                    : `Move ${option.label} down`
                                                                            }
                                                                        >
                                                                            <ArrowDown
                                                                                className="size-4"
                                                                                aria-hidden="true"
                                                                            />
                                                                        </Button>
                                                                        {isDefault ? null : (
                                                                            <Button
                                                                                type="button"
                                                                                variant="ghost"
                                                                                size="icon-sm"
                                                                                onClick={() => {
                                                                                    void setDefaultValue(
                                                                                        field.id,
                                                                                        String(option.id),
                                                                                    );
                                                                                }}
                                                                                disabled={isSubmitting}
                                                                                aria-label={`Make ${option.label} the default choice`}
                                                                                title={`Make ${option.label} the default choice`}
                                                                            >
                                                                                <Star
                                                                                    className="size-4"
                                                                                    aria-hidden="true"
                                                                                />
                                                                            </Button>
                                                                        )}
                                                                        <Button
                                                                            type="button"
                                                                            variant="ghost"
                                                                            size="icon-sm"
                                                                            aria-label={`Edit the choice ${option.label} of ${field.label}`}
                                                                            title={`Edit ${option.label}`}
                                                                            disabled={isSubmitting}
                                                                            onClick={() =>
                                                                                setOptionEditor({ field, option })
                                                                            }
                                                                        >
                                                                            <Pencil
                                                                                className="size-4"
                                                                                aria-hidden="true"
                                                                            />
                                                                        </Button>
                                                                        <Button
                                                                            type="button"
                                                                            variant="ghost"
                                                                            size="icon-sm"
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
                                                                                className="size-4"
                                                                                aria-hidden="true"
                                                                            />
                                                                        </Button>
                                                                    </div>
                                                                </div>
                                                            </li>
                                                        );
                                                    })}
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
                                            </div>
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
                isDefault={
                    optionEditor !== null &&
                    optionEditor.option !== null &&
                    String(optionEditor.option.id) === optionEditor.field.default_value
                }
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
"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import { Input } from "@/components/ui/input";
import {
    TaskCombobox,
    type TaskComboboxOption,
} from "./TaskCombobox";

import type { TaskField } from "../hooks/useTasks";
import { SingleDatePicker } from "./SingleDatePicker";

/**
 * The in-place cell editor for the task list.
 *
 * A cell opens its editor on click instead of the row's detail dialog: the editor for a column is
 * chosen from the column's TYPE, and a column the department has never seen still works because a
 * custom column's `field_type` is data. The editor keeps the dialog's controls and its payload
 * semantics — status/priority send their catalog row id, a `select` answer sends the option id as a
 * string, and an empty custom answer clears the stored answer.
 *
 * Commit strategy, uniform across the editors:
 * - Text (`title`, a `text`/`number` column): Enter or blur commits, Escape cancels; the cell
 *   editor never writes an unchanged value.
 * - Pickers (status, priority, a `select` column): picking commits immediately and the cell
 *   returns to its display state; dismissing the picker (Escape, click-outside) cancels with
 *   no write.
 * - A date cell: picking (or clearing) a day commits that one side; Escape or a click outside the
 *   cell cancels.
 *
 * The ASSIGNEES column has no inline editor at all: its cell is a compact avatar stack, and clicking
 * it opens the centered `AssigneeDialog` from the module, so a multi-member pick never has to survive
 * inside a 160px table cell. The `{ kind: "assignees" }` request below is still the wire shape that
 * dialog commits through.
 *
 * The component is presentational: it never builds an API payload and never reads a permission
 * flag. It reports the SEMANTIC change through `onCommit` and the module maps it to the route.
 */

/** One option a choice picker renders — structurally a catalog row or a custom column's choice. */
export interface CellChoice {
    readonly id: number;
    readonly label: string;
    readonly color: string | null;
}

/**
 * One department member the task list carries for its rows: the display name the modal's option list
 * resolves. Kept as a named type because `TaskRow`/`TaskTree` still thread the directory through, even
 * though the assignee picker itself now lives in the centered `AssigneeDialog` rather than in a cell.
 */
export interface CellMemberOption {
    readonly user_id: number;
    readonly full_name: string;
}

/**
 * What a cell is editing, as the row knows it. The `kind` selects the control; the payload only
 * carries what that control needs, so a new column type adds a variant here and one branch below.
 */
export type CellEditorSpec =
    | { readonly kind: "title"; readonly value: string }
    | {
          readonly kind: "catalog";
          readonly target: "status" | "priority";
          readonly options: readonly CellChoice[];
          readonly value: number | null;
      }
    | { readonly kind: "date"; readonly field: "start" | "end"; readonly value: string | null }
    | { readonly kind: "field"; readonly field: TaskField; readonly value: string | null };

/**
 * A committed cell edit, as the semantic change rather than a wire body.
 *
 * The module turns each variant into the SAME payload the edit dialog sends: `title` / `status` /
 * `priority` / `date` / `field` go through `PATCH /tasks/<id>` (`UpdateTaskSchema`), and
 * `assignees` carries the WHOLE chosen set — the module diffs it against the row's current
 * assignees and writes only the differences through the assignee route, exactly as the dialog's
 * assigner does.
 */
export type CellEditRequest =
    | { readonly kind: "title"; readonly value: string }
    | { readonly kind: "status"; readonly id: number }
    | { readonly kind: "priority"; readonly id: number }
    | { readonly kind: "assignees"; readonly userIds: readonly number[] }
    | { readonly kind: "date"; readonly field: "start" | "end"; readonly value: string | null }
    | { readonly kind: "field"; readonly fieldId: number; readonly value: string | null };

export interface TaskCellEditorProps {
    readonly spec: CellEditorSpec;
    /** The column's human name (`"Status"`, `"Due"`, a custom column's label). */
    readonly label: string;
    /** The task title, only so the editors' `aria-label` names what is being edited. */
    readonly taskTitle: string;
    readonly onCommit: (request: CellEditRequest) => void;
    readonly onCancel: () => void;
}

/** The shared geometry: every editor pins the row height so a dense table does not jump. */
const EDITOR_CLASS = "h-8 w-full min-w-0";

/** True when a key event is Escape; used by the controls that must not submit on it. */
function isEscape(event: { key: string }): boolean {
    return event.key === "Escape";
}

interface TextCellEditorProps {
    readonly label: string;
    readonly value: string;
    readonly placeholder?: string;
    readonly inputMode?: ComponentProps<"input">["inputMode"];
    /** When true an emptied value commits (and clears the answer); otherwise it is a cancel. */
    readonly allowEmptyCommit?: boolean;
    readonly onCommit: (value: string) => void;
    readonly onCancel: () => void;
}

/**
 * A free-text editor (a title or a `text`/`number` column).
 *
 * The value is local until it settles — Enter or blur commits, Escape cancels — and an untouched
 * value cancels rather than writing, so a click that opens the editor and leaves writes nothing.
 */
function TextCellEditor({
    label,
    value,
    placeholder,
    inputMode,
    allowEmptyCommit = false,
    onCommit,
    onCancel,
}: TextCellEditorProps) {
    const [text, setText] = useState(value);
    /** Guards the commit/cancel race: Enter unmounts the editor, whose blur would otherwise fire too. */
    const settledRef = useRef(false);

    const finish = (commit: boolean): void => {
        if (settledRef.current) return;
        settledRef.current = true;

        const next = text.trim();
        if (commit && (next !== "" || allowEmptyCommit) && next !== value) {
            onCommit(next);
            return;
        }
        onCancel();
    };

    return (
        <Input
            autoFocus
            value={text}
            inputMode={inputMode}
            placeholder={placeholder}
            aria-label={label}
            data-slot="task-cell-editor"
            className={EDITOR_CLASS}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    finish(true);
                } else if (isEscape(event)) {
                    event.preventDefault();
                    finish(false);
                }
            }}
            onBlur={() => finish(true)}
        />
    );
}

interface ChoiceCellEditorProps {
    readonly ariaLabel: string;
    readonly placeholder: string;
    readonly searchPlaceholder?: string;
    readonly emptyMessage?: string;
    readonly options: readonly TaskComboboxOption[];
    readonly value: string | null;
    readonly className?: string;
    readonly clearable?: boolean;
    readonly onValueChange: (value: string | null) => void;
    readonly onCancel: () => void;
}

/**
 * The shared combobox shell for every choice-style cell editor.
 *
 * The module's searchable `TaskCombobox` is the control; this wrapper supplies the two things a
 * transient cell editor needs on top of it. First, the cell geometry: the control is pinned to the
 * row's editor height (`h-8`), full width and `min-w-0`, so a long option label truncates inside the
 * trigger instead of widening the column. Second, the dismissal semantics the combobox primitive
 * does not surface: Escape or a pointer-down OUTSIDE the control cancels without writing, while a
 * pointer-down inside the portalled popup (its items, its search field) is explicitly not a
 * dismissal. Without that, clicking away would leave the editor open forever now that the popup is
 * no longer a Radix `Select` whose close event drove the cancel.
 *
 * The key and pointer listeners run in the CAPTURE phase so a control inside the popup cannot
 * swallow the Escape on its way to the document.
 */
function ChoiceCellEditor({
    ariaLabel,
    placeholder,
    searchPlaceholder,
    emptyMessage,
    options,
    value,
    className,
    clearable,
    onValueChange,
    onCancel,
}: ChoiceCellEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (isEscape(event)) onCancel();
        };
        const handlePointerDown = (event: PointerEvent): void => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (containerRef.current?.contains(target) === true) return;
            if (target.closest('[data-slot="combobox-content"]') !== null) return;
            onCancel();
        };

        document.addEventListener("keydown", handleKeyDown, true);
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => {
            document.removeEventListener("keydown", handleKeyDown, true);
            document.removeEventListener("pointerdown", handlePointerDown, true);
        };
    }, [onCancel]);

    return (
        <div ref={containerRef} className="w-full min-w-0">
            <TaskCombobox
                ariaLabel={ariaLabel}
                placeholder={placeholder}
                searchPlaceholder={searchPlaceholder}
                emptyMessage={emptyMessage}
                options={options}
                value={value}
                className={className}
                clearable={clearable}
                onValueChange={onValueChange}
            />
        </div>
    );
}

interface CatalogCellEditorProps {
    readonly label: string;
    readonly options: readonly CellChoice[];
    readonly value: number | null;
    readonly placeholder?: string;
    readonly searchPlaceholder?: string;
    /**
     * True when the column supports "no answer": the clear then COMMITS the empty value. False (a
     * status / priority, which always hold a catalog row) hides the clear and treats a stray clear
     * as a cancel, so the control never offers a misleading way to empty a required column.
     */
    readonly clearable?: boolean;
    readonly onSelect: (id: number) => void;
    readonly onClear: () => void;
    readonly onCancel: () => void;
}

/**
 * A choice picker — status, priority or a `select` column.
 *
 * The option set is a database table (`pm_task_status`, `pm_task_priority`, `pm_task_field_option`),
 * so it grows with the department and gets the module's searchable `TaskCombobox` rather than a
 * plain dropdown. A pick commits at once and the editor closes; Escape or a click outside cancels
 * with no write (see `ChoiceCellEditor`). `clearable` is the one per-column difference — a custom
 * `select` can be emptied, a status / priority cannot.
 */
function CatalogCellEditor({
    label,
    options,
    value,
    placeholder = "Pick a value",
    searchPlaceholder = "Search...",
    clearable = false,
    onSelect,
    onClear,
    onCancel,
}: CatalogCellEditorProps) {
    // Stable option identities: a fresh array each render would make the combobox re-register its
    // items and drop an in-progress search.
    const comboboxOptions = useMemo<TaskComboboxOption[]>(
        () =>
            options.map((option) => ({
                value: String(option.id),
                label: option.label,
                color: option.color,
            })),
        [options],
    );

    return (
        <ChoiceCellEditor
            ariaLabel={label}
            placeholder={placeholder}
            searchPlaceholder={searchPlaceholder}
            options={comboboxOptions}
            value={value === null ? null : String(value)}
            className={EDITOR_CLASS}
            clearable={clearable}
            onValueChange={(next) => {
                if (next === null) {
                    if (clearable) onClear();
                    else onCancel();
                    return;
                }
                onSelect(Number(next));
            }}
            onCancel={onCancel}
        />
    );
}

interface DateCellEditorProps {
    readonly label: string;
    readonly value: string | null;
    readonly onChange: (value: string | null) => void;
    readonly onCancel: () => void;
}

/** A single `date` column. Picking (or clearing) commits; leaving the cell cancels. */
function DateCellEditor({ label, value, onChange, onCancel }: DateCellEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (isEscape(event)) onCancel();
        };
        const handlePointerDown = (event: PointerEvent): void => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (containerRef.current?.contains(target) === true) return;
            if (target.closest('[data-radix-popper-content-wrapper], [data-slot="popover-content"]') !== null) return;
            onCancel();
        };

        document.addEventListener("keydown", handleKeyDown);
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.removeEventListener("pointerdown", handlePointerDown, true);
        };
    }, [onCancel]);

    return (
        <div ref={containerRef} className="w-full min-w-0">
            <SingleDatePicker
                aria-label={label}
                value={value}
                className="w-full"
                onChange={onChange}
            />
        </div>
    );
}

interface FieldCellEditorProps {
    readonly field: TaskField;
    readonly value: string | null;
    readonly taskTitle: string;
    readonly onCommit: (request: CellEditRequest) => void;
    readonly onCancel: () => void;
}

/**
 * One custom column, by its declared `field_type`.
 *
 * The switch is exhaustive over the four types the app knows; an unknown type can never reach it
 * because `useTasks` narrows an unrecognised value to `text`, so the editor always renders.
 */
function FieldCellEditor({ field, value, taskTitle, onCommit, onCancel }: FieldCellEditorProps) {
    const label = `Edit ${field.label} for ${taskTitle}`;

    if (field.field_type === "select") {
        // A stored answer is the option id as a decimal string; anything else means no selection.
        const selected = value !== null && /^\d+$/.test(value) ? Number(value) : null;
        return (
            <CatalogCellEditor
                label={label}
                options={field.options}
                value={selected}
                placeholder="Not set"
                searchPlaceholder="Search choices..."
                clearable
                onSelect={(id) => onCommit({ kind: "field", fieldId: field.id, value: String(id) })}
                onClear={() => onCommit({ kind: "field", fieldId: field.id, value: null })}
                onCancel={onCancel}
            />
        );
    }

    if (field.field_type === "date") {
        return (
            <DateCellEditor
                label={label}
                value={value}
                onChange={(next) => onCommit({ kind: "field", fieldId: field.id, value: next })}
                onCancel={onCancel}
            />
        );
    }

    const isNumber = field.field_type === "number";
    return (
        <TextCellEditor
            label={label}
            value={value ?? ""}
            inputMode={isNumber ? "decimal" : "text"}
            placeholder={isNumber ? "e.g. 42" : "Add a value"}
            allowEmptyCommit
            onCommit={(next) =>
                onCommit({
                    kind: "field",
                    fieldId: field.id,
                    value: next === "" ? null : next,
                })
            }
            onCancel={onCancel}
        />
    );
}

/**
 * The one entry point the row calls. It selects the control for `spec.kind` and maps the control's
 * own callback shape to a `CellEditRequest`; everything below is presentational.
 */
export function TaskCellEditor({ spec, label, taskTitle, onCommit, onCancel }: TaskCellEditorProps) {
    switch (spec.kind) {
        case "title":
            return (
                <TextCellEditor
                    label={`Edit ${label} for ${taskTitle}`}
                    value={spec.value}
                    placeholder="Task title"
                    onCommit={(value) => onCommit({ kind: "title", value })}
                    onCancel={onCancel}
                />
            );
        case "catalog":
            return (
                <CatalogCellEditor
                    label={`Edit ${label} for ${taskTitle}`}
                    options={spec.options}
                    value={spec.value}
                    searchPlaceholder={
                        spec.target === "status" ? "Search statuses..." : "Search priorities..."
                    }
                    onSelect={(id) =>
                        spec.target === "status"
                            ? onCommit({ kind: "status", id })
                            : onCommit({ kind: "priority", id })
                    }
                    onClear={onCancel}
                    onCancel={onCancel}
                />
            );
        case "date":
            return (
                <DateCellEditor
                    label={`Edit ${label} for ${taskTitle}`}
                    value={spec.value}
                    onChange={(next) => onCommit({ kind: "date", field: spec.field, value: next })}
                    onCancel={onCancel}
                />
            );
        case "field":
            return (
                <FieldCellEditor
                    field={spec.field}
                    value={spec.value}
                    taskTitle={taskTitle}
                    onCommit={onCommit}
                    onCancel={onCancel}
                />
            );
        default:
            return null;
    }
}

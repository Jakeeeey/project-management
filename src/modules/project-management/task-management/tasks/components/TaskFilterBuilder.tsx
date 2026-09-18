"use client";

import { useMemo, useState } from "react";
import { Bookmark, ChevronDown, Info, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    TaskCombobox,
    type TaskComboboxOption,
} from "./TaskCombobox";

import { SingleDatePicker } from "./SingleDatePicker";
import {
    ASSIGNEE_FIELD_KEY,
    FILTER_OPERATORS,
    FILTER_OPERATOR_LABELS,
    PRIORITY_FIELD_KEY,
    STATUS_FIELD_KEY,
    createFilterClause,
    customFieldIdFromKey,
    fieldFilterKey,
    fieldKind,
    operatorTakesValue,
    operatorsForKind,
    type FilterClause,
    type FilterOperator,
    type SavedTaskFilter,
} from "./task-filter";
import type { TaskField } from "../hooks/useTasks";

/**
 * The tasks FILTER BUILDER: the modal BODY — `[field] [operator] [value] [remove]` rows, a
 * `+ Add filter` button, and a `Saved filters` dropdown.
 *
 * The modal supplies the `Filters` title (see `TasksToolbar`), so this renders no heading of its own
 * and no outer card: it is a plain vertical stack so it can fill the dialog body without a box inside
 * a box. The `filters-info` tooltip stays here because it explains how the rows combine.
 *
 * Purely presentational and fully controlled — the orchestrator owns the clause array and the saved
 * sets, and this file never fetches, stores or derives a filter. The two pieces of local state it
 * does keep are the save-name input's open flag and its draft text, which are transient UI.
 *
 * Each row's value control switches on the field's TYPE: status / priority and a custom `select`
 * offer their catalog options (choice ids, never labels), a custom `date` uses the module's day
 * picker, `text` / `number` use a plain input, and assignee offers the department members. The empty
 * operators take no value, so that control renders disabled. Picking a different FIELD clears the
 * row's value, because an option id from one column is meaningless in another.
 */

/**
 * The pointer-events repair for the base-ui combobox popups this builder renders inside the Radix
 * filter modal.
 *
 * `TaskCombobox` composes `@/components/ui/combobox`, whose popup is portaled straight to `<body>`
 * (base-ui's default). A modal Radix `Dialog` sets `document.body { pointer-events: none }` while it
 * is open, so the page behind the overlay cannot be clicked, and it re-enables only its OWN portal
 * content with `pointer-events: auto` (see `[data-slot="dialog-content"]`). The combobox popup is a
 * SIBLING of that portal, not a descendant, so the popup — and every option in it — inherits
 * `pointer-events: none`. The list still renders and animates, but no option can be clicked: the
 * pointerdown falls through to the dialog beneath and merely dismisses the popup, which is exactly
 * the reported "cannot select a value" (the option list is populated, yet a click does nothing).
 *
 * Radix's own portals are modal-aware and re-enable themselves — which is why the operator control
 * (Radix `Select`) works while the field and value comboboxes do not. base-ui's portal is not
 * modal-aware, and neither the protected `@/components/ui/combobox` primitive nor `TaskCombobox`
 * may be changed here, so the popup is re-enabled from the one component that knows it lives inside
 * the modal. The `:has()` guard keeps the rule inert unless this builder is actually mounted, so no
 * combobox anywhere else in the app is affected.
 */
const FILTER_COMBOBOX_PORTAL_CSS = `body:has([data-slot="task-filter-builder"]) [data-slot="combobox-content"] {
    pointer-events: auto;
}`;

/** A choice option a value control renders; `TaskCatalogOption` / `TaskFieldOption` satisfy it. */
export interface FilterBuilderOption {
    readonly id: number;
    readonly label: string;
    /** Stored 6-digit hex, or `null` — rendered as the option's leading dot. */
    readonly color: string | null;
}

/** A department member the assignee value control renders. */
export interface FilterBuilderMember {
    readonly user_id: number;
    readonly full_name: string;
}

export interface TaskFilterBuilderProps {
    readonly clauses: readonly FilterClause[];
    readonly onClausesChange: (next: readonly FilterClause[]) => void;
    /** The department's ENABLED custom columns — the list's own `fields`, never a second fetch. */
    readonly fields: readonly TaskField[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    /** Used only to mark the signed-in member's own row in the assignee value control. */
    readonly currentUserId: number | null;
    readonly savedFilters: readonly SavedTaskFilter[];
    readonly onSaveFilter: (name: string, clauses: readonly FilterClause[]) => void;
    readonly onApplySavedFilter: (filter: SavedTaskFilter) => void;
    readonly onDeleteSavedFilter: (id: string) => void;
}

/** A radix `Select` value back to an operator; an unknown string falls back to `Is`. */
function toOperator(value: string): FilterOperator {
    return (FILTER_OPERATORS as readonly string[]).includes(value) ? (value as FilterOperator) : "is";
}

/** A non-blank combobox value, or `null` — the control's "nothing chosen" state. */
function orNull(value: string | null): string | null {
    return value === null || value === "" ? null : value;
}

/** A `TaskCombobox` over `{ id, label, color }` options, comparing by id — never by label. */
function ChoiceValueControl({
    ariaLabel,
    placeholder,
    options,
    value,
    onChange,
}: {
    readonly ariaLabel: string;
    readonly placeholder: string;
    readonly options: readonly FilterBuilderOption[];
    readonly value: string | null;
    readonly onChange: (value: string | null) => void;
}) {
    const comboboxOptions = useMemo<TaskComboboxOption[]>(
        () => options.map((option) => ({ value: String(option.id), label: option.label, color: option.color })),
        [options],
    );

    return (
        <TaskCombobox
            ariaLabel={ariaLabel}
            placeholder={placeholder}
            searchPlaceholder="Search..."
            className="w-full"
            options={comboboxOptions}
            value={orNull(value)}
            onValueChange={onChange}
        />
    );
}

/**
 * The value control for one row, switched on the field's type.
 *
 * `disabled` is the empty-operator (and no-field) state: the control is rendered but inert, so the
 * row keeps its shape without offering a value that the operator cannot use.
 */
function FilterValueControl({
    clause,
    fields,
    statuses,
    priorities,
    members,
    currentUserId,
    onChange,
}: {
    readonly clause: FilterClause;
    readonly fields: readonly TaskField[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    readonly currentUserId: number | null;
    readonly onChange: (value: string | null) => void;
}) {
    const takesValue = operatorTakesValue(clause.operator) && clause.fieldKey !== null;

    if (!takesValue) {
        return (
            <Input
                disabled
                value=""
                placeholder="No value"
                aria-label="Filter value (not used by this operator)"
                className="w-full"
                data-slot="task-filter-value-disabled"
            />
        );
    }

    const ariaLabel = "Filter value";

    if (clause.fieldKey === STATUS_FIELD_KEY) {
        return (
            <ChoiceValueControl
                ariaLabel={`${ariaLabel} (status)`}
                placeholder="Any status"
                options={statuses}
                value={clause.value}
                onChange={onChange}
            />
        );
    }

    if (clause.fieldKey === PRIORITY_FIELD_KEY) {
        return (
            <ChoiceValueControl
                ariaLabel={`${ariaLabel} (priority)`}
                placeholder="Any priority"
                options={priorities}
                value={clause.value}
                onChange={onChange}
            />
        );
    }

    if (clause.fieldKey === ASSIGNEE_FIELD_KEY) {
        const memberOptions = members.map((member) => ({
            id: member.user_id,
            label: member.user_id === currentUserId ? `${member.full_name} (you)` : member.full_name,
            color: null,
        }));
        return (
            <ChoiceValueControl
                ariaLabel={`${ariaLabel} (assignee)`}
                placeholder="Anyone"
                options={memberOptions}
                value={clause.value}
                onChange={onChange}
            />
        );
    }

    const fieldId = customFieldIdFromKey(clause.fieldKey);
    const field = fieldId === null ? undefined : fields.find((candidate) => candidate.id === fieldId);

    if (field !== undefined && field.field_type === "select") {
        return (
            <ChoiceValueControl
                ariaLabel={`${ariaLabel} (${field.label})`}
                placeholder={`Any ${field.label}`}
                options={field.options}
                value={clause.value}
                onChange={onChange}
            />
        );
    }

    if (field !== undefined && field.field_type === "date") {
        return (
            <SingleDatePicker
                value={clause.value}
                onChange={onChange}
                aria-label={`${ariaLabel} (${field.label})`}
                placeholder={`Any ${field.label}`}
                className="w-full"
            />
        );
    }

    if (field !== undefined && field.field_type === "number") {
        return (
            <Input
                type="number"
                inputMode="decimal"
                value={clause.value ?? ""}
                onChange={(event) => onChange(event.target.value)}
                placeholder={`Filter ${field.label}`}
                aria-label={`${ariaLabel} (${field.label})`}
                className="w-full"
            />
        );
    }

    return (
        <Input
            type="text"
            value={clause.value ?? ""}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field === undefined ? "Filter value" : `Search ${field.label}`}
            aria-label={field === undefined ? ariaLabel : `${ariaLabel} (${field.label})`}
            className="w-full"
        />
    );
}

/** One builder row: field picker, operator picker, value control, remove button. */
function FilterClauseRow({
    clause,
    fields,
    statuses,
    priorities,
    members,
    currentUserId,
    onChange,
    onRemove,
}: {
    readonly clause: FilterClause;
    readonly fields: readonly TaskField[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    readonly currentUserId: number | null;
    readonly onChange: (next: FilterClause) => void;
    readonly onRemove: () => void;
}) {
    const fieldOptions = useMemo<TaskComboboxOption[]>(
        () => [
            { value: STATUS_FIELD_KEY, label: "Status" },
            { value: PRIORITY_FIELD_KEY, label: "Priority" },
            { value: ASSIGNEE_FIELD_KEY, label: "Assignee" },
            ...fields.map((field) => ({ value: fieldFilterKey(field.id), label: field.label })),
        ],
        [fields],
    );

    const operators = operatorsForKind(fieldKind(clause.fieldKey, fields));

    /** Changing the field clears the value and coerces the operator to one the new kind supports. */
    const changeField = (fieldKey: string | null): void => {
        const kind = fieldKind(fieldKey, fields);
        const allowed = operatorsForKind(kind);
        onChange({
            ...clause,
            fieldKey,
            operator: allowed.includes(clause.operator) ? clause.operator : "is",
            value: null,
        });
    };

    return (
        /*
         * ONE clause = ONE row. A 4-column grid (not a wrapping flex) gives every control a
         * predictable share and makes wrapping impossible at ANY width: the first three columns are
         * `minmax(0, …)` flexible tracks (they shrink and their text truncates) and the last is an
         * `auto` track that hugs the remove button. `min-w-0` on each flexible child lets a long
         * option label truncate inside its control instead of widening the row or overflowing the
         * modal. At narrow widths the row stays a single row and the controls shrink — it never falls
         * back to the old broken two-line wrap.
         */
        <div
            data-slot="task-filter-row"
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2"
        >
            <TaskCombobox
                ariaLabel="Filter field"
                placeholder="Select field"
                searchPlaceholder="Search fields..."
                className="w-full min-w-0"
                options={fieldOptions}
                value={clause.fieldKey}
                onValueChange={changeField}
            />

            <Select value={clause.operator} onValueChange={(next) => onChange({ ...clause, operator: toOperator(next) })}>
                <SelectTrigger className="w-full min-w-0" aria-label="Filter operator">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {operators.map((operator) => (
                        <SelectItem key={operator} value={operator}>
                            {FILTER_OPERATOR_LABELS[operator]}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            <div className="w-full min-w-0">
                <FilterValueControl
                    clause={clause}
                    fields={fields}
                    statuses={statuses}
                    priorities={priorities}
                    members={members}
                    currentUserId={currentUserId}
                    onChange={(value) => onChange({ ...clause, value })}
                />
            </div>

            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove filter"
                title="Remove filter"
                data-slot="task-filter-remove"
                className="shrink-0 justify-self-end text-muted-foreground hover:text-destructive"
                onClick={onRemove}
            >
                <Trash2 className="size-4" aria-hidden="true" />
            </Button>
        </div>
    );
}

export function TaskFilterBuilder({
    clauses,
    onClausesChange,
    fields,
    statuses,
    priorities,
    members,
    currentUserId,
    savedFilters,
    onSaveFilter,
    onApplySavedFilter,
    onDeleteSavedFilter,
}: TaskFilterBuilderProps) {
    const [isNaming, setIsNaming] = useState(false);
    const [draftName, setDraftName] = useState("");

    const updateClause = (next: FilterClause): void => {
        onClausesChange(clauses.map((clause) => (clause.id === next.id ? next : clause)));
    };

    const removeClause = (id: string): void => {
        onClausesChange(clauses.filter((clause) => clause.id !== id));
    };

    const addClause = (): void => {
        onClausesChange([...clauses, createFilterClause()]);
    };

    const commitSave = (): void => {
        if (draftName.trim() === "" || clauses.length === 0) return;
        onSaveFilter(draftName, clauses);
        setDraftName("");
        setIsNaming(false);
    };

    return (
        <div data-slot="task-filter-builder" className="space-y-3">
            <style>{FILTER_COMBOBOX_PORTAL_CSS}</style>

            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label="How filters combine"
                                data-slot="filters-info"
                                className="text-muted-foreground"
                            >
                                <Info className="size-4" aria-hidden="true" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-64">
                            Filters combine with AND: a task must match every active row. A row with no
                            field, or a value-taking row with no value, is ignored.
                        </TooltipContent>
                    </Tooltip>
                </div>

                {isNaming ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            autoFocus
                            value={draftName}
                            onChange={(event) => setDraftName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    commitSave();
                                }
                                if (event.key === "Escape") {
                                    setIsNaming(false);
                                    setDraftName("");
                                }
                            }}
                            placeholder="Filter name"
                            aria-label="Saved filter name"
                            className="h-9 w-40"
                        />
                        <Button
                            type="button"
                            size="sm"
                            onClick={commitSave}
                            disabled={draftName.trim() === ""}
                        >
                            Save
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                setIsNaming(false);
                                setDraftName("");
                            }}
                        >
                            Cancel
                        </Button>
                    </div>
                ) : (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                data-slot="saved-filters-trigger"
                                aria-label="Saved filters"
                            >
                                <Bookmark className="size-4" aria-hidden="true" />
                                Saved filters
                                <ChevronDown className="size-4" aria-hidden="true" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuLabel>Saved filters</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {savedFilters.length === 0 ? (
                                <DropdownMenuItem disabled>No saved filters</DropdownMenuItem>
                            ) : (
                                savedFilters.map((filter) => (
                                    <DropdownMenuSub key={filter.id}>
                                        <DropdownMenuSubTrigger>
                                            <span className="min-w-0 truncate">{filter.name}</span>
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem onSelect={() => onApplySavedFilter(filter)}>
                                                Apply
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                variant="destructive"
                                                onSelect={() => onDeleteSavedFilter(filter.id)}
                                            >
                                                Delete
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                ))
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                disabled={clauses.length === 0}
                                onSelect={() => setIsNaming(true)}
                            >
                                Save current filters…
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            {clauses.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    No filters yet. Add one to narrow the list.
                </p>
            ) : (
                <div className="space-y-2">
                    {clauses.map((clause) => (
                        <FilterClauseRow
                            key={clause.id}
                            clause={clause}
                            fields={fields}
                            statuses={statuses}
                            priorities={priorities}
                            members={members}
                            currentUserId={currentUserId}
                            onChange={updateClause}
                            onRemove={() => removeClause(clause.id)}
                        />
                    ))}
                </div>
            )}

            <Button
                type="button"
                variant="outline"
                size="sm"
                data-slot="task-filter-add"
                onClick={addClause}
            >
                <Plus className="size-4" aria-hidden="true" />
                Add filter
            </Button>
        </div>
    );
}

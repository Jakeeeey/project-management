"use client";

import { useMemo } from "react";

import { Input } from "@/components/ui/input";
import {
    TaskCombobox,
    type TaskComboboxOption,
} from "@/modules/project-management/components/TaskCombobox";

import { SingleDatePicker } from "./SingleDatePicker";
import type { TaskField } from "../hooks/useTasks";

/**
 * The "filter by field" control: pick a column, then give its value.
 *
 * The clause is the field selector's result — a `fieldKey` naming the target plus the string
 * `value` to match. It is a filter ONLY when both halves are present and the value is non-blank,
 * so choosing a column before typing anything never blanks the list. Changing the field drops the
 * previous value: an option id from one column is meaningless in another.
 *
 * Everything is presentational: the orchestrator owns the clause state and the match predicate, and
 * the columns arrive already loaded (the list's enabled-only `fields`, the department's catalogs).
 * The key encoding lives here so the selector and the predicate cannot disagree about it.
 *
 * The field picker and every Choice value control are searchable `TaskCombobox`es — their options
 * are rows from `pm_task_field` / `pm_task_field_option`, so the list grows with the department and
 * must be filterable. Each carries a real clear (X) control, so "no field" / "any value" is a
 * control state rather than a sentinel list row.
 */

/** The clause key of the built-in status column. */
export const STATUS_FIELD_KEY = "status";
/** The clause key of the built-in priority column. */
export const PRIORITY_FIELD_KEY = "priority";
/** The prefix a custom column's clause key carries before its id. */
const CUSTOM_FIELD_KEY_PREFIX = "field:";

/**
 * The "filter by field" clause.
 *
 * `fieldKey` is `"status"`, `"priority"` or `"field:<id>"` for a custom column, or `null` when no
 * field is picked. `value` is the field's stored string form (an option id for a Choice, a
 * `YYYY-MM-DD` for a date) — `null` or `""` means "no clause".
 */
export interface FieldFilterClause {
    readonly fieldKey: string | null;
    readonly value: string | null;
}

/** The initial / cleared clause, shared so the state starts and resets on one identity. */
export const NO_FIELD_FILTER: FieldFilterClause = { fieldKey: null, value: null };

/** The option shape this control renders; `TaskCatalogOption` / `TaskFieldOption` satisfy it. */
export interface TaskFieldFilterOption {
    readonly id: number;
    readonly label: string;
    readonly color: string | null;
}

/** The clause key of a custom column. */
export function fieldFilterKey(fieldId: number): string {
    return `${CUSTOM_FIELD_KEY_PREFIX}${fieldId}`;
}

/** The id a custom-column clause key encodes, or `null` for a built-in key or anything malformed. */
export function customFieldIdFromKey(fieldKey: string | null): number | null {
    if (fieldKey === null || !fieldKey.startsWith(CUSTOM_FIELD_KEY_PREFIX)) return null;
    const parsed = Number(fieldKey.slice(CUSTOM_FIELD_KEY_PREFIX.length));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** True when the clause actually filters something — a field AND a non-blank value. */
export function isFieldFilterActive(clause: FieldFilterClause): boolean {
    return clause.fieldKey !== null && clause.value !== null && clause.value.trim() !== "";
}

/** A Choice value control for the built-in `status` / `priority` catalogs, tinted from the catalog. */
function CatalogValueSelect({
    ariaLabel,
    placeholder,
    options,
    value,
    onChange,
}: {
    readonly ariaLabel: string;
    readonly placeholder: string;
    readonly options: readonly TaskFieldFilterOption[];
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
            className="w-full lg:w-40"
            options={comboboxOptions}
            value={value === null || value === "" ? null : value}
            onValueChange={onChange}
        />
    );
}

/** The Choice value control for one custom `select` column — option ids as decimal strings. */
function CustomChoiceControl({
    field,
    value,
    onChange,
}: {
    readonly field: TaskField;
    readonly value: string | null;
    readonly onChange: (value: string | null) => void;
}) {
    const ariaLabel = `${field.label} filter value`;
    const options = useMemo<TaskComboboxOption[]>(
        () => field.options.map((option) => ({ value: String(option.id), label: option.label, color: option.color })),
        [field.options],
    );

    return (
        <TaskCombobox
            ariaLabel={ariaLabel}
            placeholder={`Any ${field.label}`}
            className="w-full lg:w-44"
            options={options}
            value={value === null || value === "" ? null : value}
            onValueChange={onChange}
        />
    );
}

/**
 * The value control for one custom column — it switches on the column's own type.
 *
 * A Choice column compares by OPTION ID (never label), so its options are offered as
 * `{ value: String(option.id), label }`. A date uses the module's shared day picker, and text /
 * number fall back to a plain input whose string is the stored answer's string form.
 */
function CustomValueControl({
    field,
    value,
    onChange,
}: {
    readonly field: TaskField;
    readonly value: string | null;
    readonly onChange: (value: string | null) => void;
}) {
    const ariaLabel = `${field.label} filter value`;

    if (field.field_type === "select") {
        return <CustomChoiceControl field={field} value={value} onChange={onChange} />;
    }

    if (field.field_type === "date") {
        return (
            <SingleDatePicker
                value={value}
                onChange={onChange}
                aria-label={ariaLabel}
                placeholder={`Any ${field.label}`}
                className="w-full lg:w-44"
            />
        );
    }

    return (
        <Input
            type={field.field_type === "number" ? "number" : "text"}
            inputMode={field.field_type === "number" ? "decimal" : undefined}
            value={value ?? ""}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.field_type === "number" ? `Filter ${field.label}` : `Search ${field.label}`}
            aria-label={ariaLabel}
            className="w-full lg:w-40"
        />
    );
}

export interface TaskFieldFilterProps {
    readonly clause: FieldFilterClause;
    readonly onClauseChange: (next: FieldFilterClause) => void;
    /** The department's ENABLED custom columns — the list's own `fields`, never a second fetch. */
    readonly fields: readonly TaskField[];
    readonly statuses: readonly TaskFieldFilterOption[];
    readonly priorities: readonly TaskFieldFilterOption[];
}

export function TaskFieldFilter({
    clause,
    onClauseChange,
    fields,
    statuses,
    priorities,
}: TaskFieldFilterProps) {
    const selectedFieldId = customFieldIdFromKey(clause.fieldKey);
    const selectedField =
        selectedFieldId === null ? undefined : fields.find((field) => field.id === selectedFieldId);

    // One value control per active field, so a change never writes a value under a stale key.
    const setValue = (value: string | null): void => {
        onClauseChange({ fieldKey: clause.fieldKey, value });
    };

    // Built-ins first, then the department's own columns — a stable identity so the combobox keeps
    // an in-progress search across this component's renders.
    const fieldOptions = useMemo<TaskComboboxOption[]>(
        () => [
            { value: STATUS_FIELD_KEY, label: "Status" },
            { value: PRIORITY_FIELD_KEY, label: "Priority" },
            ...fields.map((field) => ({ value: fieldFilterKey(field.id), label: field.label })),
        ],
        [fields],
    );

    return (
        <div
            data-slot="task-field-filter"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:shrink-0 lg:items-center"
        >
            {/*
             * Changing the field always drops the previous value: another column's option id
             * would silently match nothing.
             */}
            <TaskCombobox
                ariaLabel="Filter by field"
                placeholder="Filter by field"
                searchPlaceholder="Search fields..."
                className="w-full lg:w-44"
                options={fieldOptions}
                value={clause.fieldKey}
                onValueChange={(next) => onClauseChange({ fieldKey: next, value: null })}
            />

            {clause.fieldKey === STATUS_FIELD_KEY ? (
                <CatalogValueSelect
                    ariaLabel="Status filter value"
                    placeholder="Any status"
                    options={statuses}
                    value={clause.value}
                    onChange={setValue}
                />
            ) : null}

            {clause.fieldKey === PRIORITY_FIELD_KEY ? (
                <CatalogValueSelect
                    ariaLabel="Priority filter value"
                    placeholder="Any priority"
                    options={priorities}
                    value={clause.value}
                    onChange={setValue}
                />
            ) : null}

            {selectedField !== undefined ? (
                <CustomValueControl field={selectedField} value={clause.value} onChange={setValue} />
            ) : null}
        </div>
    );
}

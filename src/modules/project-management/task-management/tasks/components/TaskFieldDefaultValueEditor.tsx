"use client";

import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";

import type { TaskField } from "../hooks/useTasks";
import { SingleDatePicker } from "./SingleDatePicker";

/**
 * The "No default" choice is a real option in the list, and `SearchableSelect` only ever reports a
 * string, so clearing needs an option whose value cannot collide with an option id. Option ids are
 * numeric strings, so a sentinel word is unambiguous; it maps back to `null` on commit, which is what
 * the server stores for "no default".
 */
const NO_DEFAULT_ITEM = "__no_default__";

export interface TaskFieldDefaultValueEditorProps {
    readonly field: TaskField;
    /** True while a mutation is in flight; never tied to `field.is_enabled`. */
    readonly disabled: boolean;
    readonly onCommit: (value: string | null) => void;
}

/**
 * The default-value control for one column, adapting to the column's type.
 *
 * Text and number drafts are local and commit on blur (or Enter) rather than per keystroke: the
 * server is the source of truth and every committed value costs a refetch, so typing must not fan out
 * into one request per character. Choice and date are discrete and commit immediately.
 *
 * A Choice column uses `SearchableSelect` — the project's standard combobox — rather than a select,
 * because a Choice column routinely carries a dozen or more options and a plain dropdown makes the one
 * you want something to hunt for. It is searchable for the same reason the builder itself is now
 * collapsed and paginated.
 *
 * The draft is seeded from the prop, not synced to it: the call site keys this component on the
 * column's stored default, so a refetch after a write remounts it with the authoritative value.
 */
export function TaskFieldDefaultValueEditor({
    field,
    disabled,
    onCommit,
}: TaskFieldDefaultValueEditorProps) {
    const [draft, setDraft] = useState(field.default_value ?? "");

    const choices = useMemo(
        () => [
            { value: NO_DEFAULT_ITEM, label: "No default" },
            ...field.options.map((option) => ({ value: String(option.id), label: option.label })),
        ],
        [field.options],
    );

    const commitDraft = () => {
        const next = draft.trim();
        if (next === (field.default_value ?? "")) return;
        onCommit(next === "" ? null : next);
    };

    if (field.field_type === "select") {
        return (
            <SearchableSelect
                options={choices}
                value={field.default_value ?? NO_DEFAULT_ITEM}
                onValueChange={(value) => onCommit(value === NO_DEFAULT_ITEM ? null : value)}
                placeholder="No default"
                disabled={disabled}
                className="w-full"
            />
        );
    }

    if (field.field_type === "date") {
        return (
            <SingleDatePicker
                value={field.default_value}
                onChange={onCommit}
                aria-label={`Default date for ${field.label}`}
                placeholder="No default date"
                disabled={disabled}
            />
        );
    }

    const isNumber = field.field_type === "number";

    return (
        <Input
            aria-label={`Default value for ${field.label}`}
            placeholder={isNumber ? "No default number" : "No default text"}
            autoComplete="off"
            disabled={disabled}
            inputMode={isNumber ? "decimal" : undefined}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
            }}
        />
    );
}

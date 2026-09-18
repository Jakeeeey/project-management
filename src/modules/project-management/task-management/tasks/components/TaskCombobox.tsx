"use client";

import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
    ComboboxTrigger,
    ComboboxValue,
} from "@/components/ui/combobox";
import { CatalogStatusIcon } from "./CatalogStatusIcon";

/**
 * The ONE searchable single-select combobox for the project-management module.
 *
 * This is the module's shared "choose one row from a table" control. It composes the project's
 * existing `@/components/ui/combobox` primitive (base-ui) for the popup, list, items and search —
 * nothing about the popup is hand-rolled — and adds the module's own trigger row so every call site
 * gets the same behaviour and sizing:
 *
 * - A trigger showing the CURRENT value (or the placeholder while nothing is chosen).
 * - A search input INSIDE the popup, so a long catalog/member list is type-to-filter.
 * - A per-option leading icon, rendered by `CatalogStatusIcon` so a status/priority/custom-field
 *   option looks exactly like it does everywhere else. By default the icon is ALWAYS drawn — an
 *   option with no stored icon falls back to the foundation's default marker rather than leaving
 *   the column blank — but a row set that is NOT a catalog can opt out with `showStatusIcon={false}`,
 *   because the fallback marker on a row that has no status reads as an unselected radio, not as
 *   information.
 * - A visible CLEAR (X) button, rendered only while a value is selected, so "how do I remove a
 *   value" is answered by the control itself rather than by a fake first list row labelled with
 *   the placeholder.
 *
 * ## Choosing searchable vs a plain dropdown
 *
 * Use this control when the options come from a DATABASE TABLE — the row set is dynamic in size
 * (`pm_task_status`, `pm_task_priority`, `user`, `pm_task_field`, `pm_task_field_option`). A
 * searchable list stays usable as a department grows. Use the plain `Select` only for a fully
 * preconfigured, finite enum the user can never edit (for example the Configure page's 4-value
 * field-type picker) — and still prefer THIS control when such a predefined list is long.
 *
 * ## Contract
 *
 * Fully controlled and presentational: the caller owns `value`, this component never fetches and
 * never derives a selection. `value` is the option's stable identity (a catalog id as a decimal
 * string, a column key, a user id) and `null` means "nothing selected" — never a sentinel string.
 */

/** One row of a `TaskCombobox` list. */
export interface TaskComboboxOption {
    /**
     * The stable identity the caller's model stores. For a catalog row this is the id as a decimal
     * string; the caller compares by this, never by `label`.
     */
    readonly value: string;
    /** The label a person reads, rendered verbatim and truncated to the control's width. */
    readonly label: string;
    /**
     * Optional stored catalog hex that tints the row's leading icon. A row with no colour renders the
     * icon in the inherited foreground, which is different from a deliberately neutral dot.
     */
    readonly color?: string | null;
    /**
     * Optional allow-listed icon name. Omitted or `null` renders the foundation's default marker, so
     * every row leads with a glyph and the option columns never shift between icon and no icon.
     */
    readonly icon?: string | null;
}

export interface TaskComboboxProps {
    /** The current option set, in the order they should be presented. */
    readonly options: readonly TaskComboboxOption[];
    /** The selected option's `value`, or `null` for no selection. Controlled. */
    readonly value: string | null;
    /** Receives the next option `value`, or `null` when the clear affordance is used. */
    readonly onValueChange: (value: string | null) => void;
    /** Shown in the trigger while nothing is selected. */
    readonly placeholder?: string;
    /**
     * The control's accessible name, e.g. "Filter by status". Applied to the trigger, which is the
     * combobox's form control while the search input lives inside the popup.
     */
    readonly ariaLabel: string;
    readonly disabled?: boolean;
    /** The caller's width/layout classes, merged last so a call site owns its own column. */
    readonly className?: string;
    /** Placeholder for the popup's search field. Defaults to "Search...". */
    readonly searchPlaceholder?: string;
    /** Copy shown when the search term matches no option. Defaults to "No matches.". */
    readonly emptyMessage?: string;
    /**
     * Whether the control offers its clear (X) affordance while a value is selected. Defaults to
     * `true`, so every existing call site keeps its clear. Set `false` for a required choice — a
     * control whose value can never be empty — so the clear is not rendered at all rather than
     * hidden with CSS.
     */
    readonly clearable?: boolean;
    /**
     * Whether the trigger and every option lead with the stored catalog glyph. Defaults to `true`.
     *
     * A catalog row — a status, a priority, a custom-field option — carries its stored icon and
     * colour as part of its identity, so the glyph belongs there. A row set that is NOT a catalog
     * (a task list has no status and no stored icon) must set this to `false`: without it the
     * foundation's fallback marker would put a meaningless circle in front of every name, reading
     * as an unselected radio. The selected row's check is the only mark such a control needs.
     */
    readonly showStatusIcon?: boolean;
}

/** Labels, colours and icons keyed by option value, so the render pass does not scan the array per row. */
function indexOptions(options: readonly TaskComboboxOption[]): {
    labels: Map<string, string>;
    colors: Map<string, string>;
    icons: Map<string, string>;
} {
    const labels = new Map<string, string>();
    const colors = new Map<string, string>();
    const icons = new Map<string, string>();
    for (const option of options) {
        labels.set(option.value, option.label);
        if (typeof option.color === "string" && option.color !== "") {
            colors.set(option.value, option.color);
        }
        if (typeof option.icon === "string" && option.icon !== "") {
            icons.set(option.value, option.icon);
        }
    }
    return { labels, colors, icons };
}

export function TaskCombobox({
    options,
    value,
    onValueChange,
    placeholder = "Select...",
    ariaLabel,
    disabled = false,
    className,
    searchPlaceholder = "Search...",
    emptyMessage = "No matches.",
    clearable = true,
    showStatusIcon = true,
}: TaskComboboxProps) {
    const { labels, colors, icons } = React.useMemo(() => indexOptions(options), [options]);

    /**
     * The primitive filters its list by the item values it is given. Passing the option VALUES (not
     * the option objects) keeps `value`/`onValueChange` a plain string, and `itemToStringLabel`
     * makes the typed search and the trigger display resolve the option's human label instead.
     */
    const itemValues = React.useMemo(() => options.map((option) => option.value), [options]);

    return (
        <Combobox
            items={itemValues}
            value={value}
            onValueChange={onValueChange}
            itemToStringLabel={(itemValue) => labels.get(itemValue) ?? itemValue}
            disabled={disabled}
        >
            <div
                data-slot="task-combobox"
                className={cn(
                    "relative flex h-9 w-full min-w-0 items-center rounded-md border border-input bg-transparent pr-1 shadow-xs transition-[color,box-shadow] outline-none dark:bg-input/30",
                    "has-[:focus-visible]:border-ring has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]",
                    disabled && "cursor-not-allowed opacity-50",
                    className,
                )}
            >
                <ComboboxTrigger
                    className={cn(
                        "flex h-full min-w-0 flex-1 items-center gap-2 rounded-md bg-transparent px-3 text-left text-sm outline-none",
                        "data-[placeholder]:text-muted-foreground disabled:cursor-not-allowed",
                        "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                    )}
                    aria-label={ariaLabel}
                >
                    {/*
                     * The selected value leads with its stored icon — the same glyph the read-only
                     * row chip shows — so opening the editor never changes what the value looks
                     * like. `tone="status"` because the trigger is a bare surface, not a filled pill.
                     * Skipped entirely when the caller has opted out: a list has no glyph to show,
                     * and the fallback marker would be a stray circle, not information.
                     */}
                    {value === null || !showStatusIcon ? null : (
                        <CatalogStatusIcon
                            icon={icons.get(value)}
                            color={colors.get(value)}
                            tone="status"
                            density="comfortable"
                        />
                    )}
                    {/*
                     * The label truncates inside the trigger's flexible middle, so a long catalog
                     * name can never widen the control past the caller's `w-*` cap.
                     */}
                    <span className="min-w-0 flex-1 truncate">
                        <ComboboxValue placeholder={placeholder} />
                    </span>
                </ComboboxTrigger>

                {/*
                 * The clear affordance: a real X on the control, shown only while a value is
                 * selected and the control is clearable. The wrapper is fully controlled, so
                 * clearing is just `onValueChange(null)` — the escape hatch the old dropdowns
                 * buried as a fake first row labelled with the placeholder.
                 */}
                {clearable && value !== null ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        data-slot="combobox-clear"
                        aria-label={`Clear ${ariaLabel}`}
                        title={`Clear ${ariaLabel}`}
                        disabled={disabled}
                        className="shrink-0"
                        onClick={() => onValueChange(null)}
                    >
                        <X className="size-3.5" aria-hidden="true" />
                    </Button>
                ) : null}
            </div>

            <ComboboxContent>
                <ComboboxInput
                    showTrigger={false}
                    showClear={false}
                    disabled={disabled}
                    placeholder={searchPlaceholder}
                    aria-label={`Search ${ariaLabel}`}
                />
                <ComboboxList>
                    {(itemValue: string) => (
                        <ComboboxItem key={itemValue} value={itemValue}>
                            {/*
                             * The glyph is ALWAYS drawn for a catalog: an option with no stored icon
                             * falls back to the foundation's default marker, so the option column
                             * stays uniform. A non-catalog row set opts out (`showStatusIcon={false}`)
                             * so its rows are plain text and the selected check is the only mark.
                             */}
                            {showStatusIcon ? (
                                <CatalogStatusIcon
                                    icon={icons.get(itemValue)}
                                    color={colors.get(itemValue)}
                                    tone="status"
                                    density="comfortable"
                                />
                            ) : null}
                            <span className="min-w-0 truncate">
                                {labels.get(itemValue) ?? itemValue}
                            </span>
                        </ComboboxItem>
                    )}
                </ComboboxList>
                <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
            </ComboboxContent>
        </Combobox>
    );
}

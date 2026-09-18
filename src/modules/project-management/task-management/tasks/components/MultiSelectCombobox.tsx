"use client";

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
    resolveCatalogForeground,
    resolveCatalogHex,
} from "./CatalogChip";
import { CatalogStatusIcon } from "./CatalogStatusIcon";

/**
 * The ONE searchable MULTI-SELECT combobox for the project-management module.
 *
 * It is built the way the house reference (the HRM training-templates `MultiCombobox`) builds its
 * multiselect, because that shape is the one the module's QA conventions bless: a `Popover` wrapping
 * a `Command`, a `Button` trigger that renders the selection as removable `Badge` chips, and a
 * searchable list whose rows toggle while the popup STAYS OPEN. `Command` gives the search and the
 * keyboard navigation for free and the `Popover` gives the anchored, width-matched surface, so the
 * control carries no bespoke combobox primitive of its own.
 *
 * What it keeps from the module that the reference does not have: an option may carry a stored hex
 * (`color`), and that hex tints BOTH the option's chip and its leading list icon. The caller derives
 * the colour (`assigneeColorFor(user.id)`) and the tint's readable ink comes from the module's one
 * WCAG decision, `resolveCatalogForeground`, so an assignee chip here can never disagree with the
 * same person's avatar in the table.
 *
 * ## Shared pieces
 *
 * The chip rendering and the option list are EXPORTED, not inlined, so the assignees modal
 * (`tasks/components/AssigneeDialog.tsx`) can show the same current-selection chips and the same
 * pickable, searchable list WITHOUT nesting a popover inside itself:
 *
 * - {@link MultiSelectChipRow} — the removable chip row (the trigger's contents and the modal body).
 * - {@link MultiSelectOptionList} — the check-marked list (the popover body and the modal body).
 *
 * The two surfaces therefore cannot drift: a change to how a chip looks or how a row toggles lands
 * in both at once.
 *
 * ## Choosing searchable vs a plain dropdown
 *
 * Same rule as `TaskCombobox`: a DATABASE TABLE source (`user`, `pm_task_status`, `pm_task_field`, …)
 * whose size grows gets a searchable combobox. A fixed, preconfigured enum the user can never edit is
 * the only thing that stays a plain `Select`.
 *
 * ## Contract
 *
 * Fully controlled and presentational: the caller owns `values`, this component never fetches and
 * never derives a selection. A `value` is the option's stable identity (a user id as a decimal string,
 * a catalog id, a field key) and the caller compares by it, never by `label`.
 */

/** One row of a `MultiSelectCombobox` list. */
export interface MultiSelectComboboxOption {
    /** The stable identity the caller's model stores; it compares by this, never by `label`. */
    readonly value: string;
    /** The label a person reads, rendered verbatim and truncated to the control's width. */
    readonly label: string;
    /**
     * Optional stored hex that tints the option's chip and its leading list icon. It is the caller's
     * job to derive it (an assignee passes `assigneeColorFor(user.id)`); a row without a colour keeps
     * the neutral chip and the inherited-ink icon, which is different from a deliberately neutral dot.
     */
    readonly color?: string | null;
    /**
     * Optional allow-listed icon name. Omitted or `null` renders the foundation's default marker, so
     * every row and chip leads with a glyph and the control never shifts between icon and no icon.
     */
    readonly icon?: string | null;
    /**
     * Extra text the search matches but never displays — an email, a role. Optional, so a plain
     * id/label list searches by label alone.
     */
    readonly keywords?: string;
}

export interface MultiSelectComboboxProps {
    /** The current option set, in the order they should be presented. */
    readonly options: readonly MultiSelectComboboxOption[];
    /** The selected option values. Controlled. */
    readonly values: readonly string[];
    /** Receives the next full selection — after a pick, a chip removal or a clear. */
    readonly onValuesChange: (values: string[]) => void;
    /** Shown in the trigger while nothing is selected. */
    readonly placeholder?: string;
    /** Shown in the popover's search field. */
    readonly searchPlaceholder?: string;
    /** Shown in the popover when the search matches nothing. */
    readonly emptyMessage?: string;
    /** The control's accessible name, e.g. "Assignees". Applied to the trigger. */
    readonly ariaLabel: string;
    readonly disabled?: boolean;
    /** The caller's width/layout classes, merged last so a call site owns its own column. */
    readonly className?: string;
    /**
     * Whether the control offers its clear-all (X) affordance while something is selected. Defaults
     * to `true`, mirroring `TaskCombobox`, so the two behave alike. Set `false` for a required choice.
     */
    readonly clearable?: boolean;
}

/** The searchable text for one option: its label, any hidden keywords, then its unique value. */
function commandValueFor(option: MultiSelectComboboxOption): string {
    const keywords =
        option.keywords === undefined || option.keywords === "" ? "" : ` ${option.keywords}`;
    return `${option.label}${keywords} ${option.value}`;
}

/** The hidden terms cmdk may additionally match — the label plus any caller-supplied keywords. */
function commandKeywordsFor(option: MultiSelectComboboxOption): string[] {
    return option.keywords === undefined || option.keywords === ""
        ? [option.label]
        : [option.label, option.keywords];
}

/** Labels, colours and icons keyed by value, so a render pass resolves each selected value only once. */
function indexOptions(options: readonly MultiSelectComboboxOption[]): {
    labelByValue: Map<string, string>;
    colorByValue: Map<string, string | null>;
    iconByValue: Map<string, string>;
} {
    const labelByValue = new Map<string, string>();
    const colorByValue = new Map<string, string | null>();
    const iconByValue = new Map<string, string>();
    for (const option of options) {
        labelByValue.set(option.value, option.label);
        colorByValue.set(option.value, option.color ?? null);
        if (typeof option.icon === "string" && option.icon !== "") {
            iconByValue.set(option.value, option.icon);
        }
    }
    return { labelByValue, colorByValue, iconByValue };
}

export interface MultiSelectChipProps {
    /** The chip's visible text — already the resolved label, not a raw id. */
    readonly label: string;
    /** Stored 6-digit hex; anything else keeps the neutral `Badge` styling. */
    readonly color?: string | null;
    /** Allow-listed icon name, or `null`/omitted for the foundation's default marker. */
    readonly icon?: string | null;
    /** Removes this one value from the selection. */
    readonly onRemove: () => void;
}

/**
 * One removable selection chip. Rendered by {@link MultiSelectChipRow} for every selected value, so
 * the combobox trigger and the assignees modal show IDENTICAL chips.
 *
 * The tint is an inline style because a class literal cannot express an arbitrary runtime hex. The
 * remove control is a focusable `span` with its own event handlers that stop propagation, so a click
 * removes the value without also toggling the popover or submitting a surrounding form.
 */
export function MultiSelectChip({ label, color, icon, onRemove }: MultiSelectChipProps) {
    const hex = resolveCatalogHex(color);

    return (
        <Badge
            variant="secondary"
            className="max-w-[160px] items-center gap-1 pr-1"
            title={label}
            style={
                hex === null
                    ? undefined
                    : { backgroundColor: hex, color: resolveCatalogForeground(hex) }
            }
        >
            {/*
             * A filled chip takes the legibility-derived contrast ink, exactly like the row's chip;
             * the neutral (colourless) chip uses the inherited foreground so the glyph stays visible.
             * The glyph is always drawn — a missing icon falls back to the default marker.
             */}
            <CatalogStatusIcon
                icon={icon}
                color={hex}
                tone={hex === null ? "status" : "contrast"}
                density="comfortable"
            />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span
                role="button"
                tabIndex={0}
                aria-label={`Remove ${label}`}
                className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-muted-foreground/20"
                onClick={(event) => {
                    event.stopPropagation();
                    onRemove();
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        onRemove();
                    }
                }}
            >
                <X className="h-3 w-3" aria-hidden="true" />
            </span>
        </Badge>
    );
}

export interface MultiSelectChipRowProps {
    /** The option set the selected values resolve their labels and colours from. */
    readonly options: readonly MultiSelectComboboxOption[];
    /** The selected values, in the order the chips should render. */
    readonly values: readonly string[];
    /** Removes one value from the selection. */
    readonly onRemove: (value: string) => void;
    /** Extra layout classes from the surface; the row is already a wrapping flex line. */
    readonly className?: string;
}

/**
 * The removable chip row. The combobox trigger wraps it (with `flex-1 text-left`) and the assignees
 * modal renders it in its "Selected" area, so both surfaces agree on chip order, truncation and the
 * per-user colour. A value whose option is no longer in the set still renders (labelled by the value
 * itself) so it stays removable instead of silently disappearing.
 */
export function MultiSelectChipRow({
    options,
    values,
    onRemove,
    className,
}: MultiSelectChipRowProps) {
    const { labelByValue, colorByValue, iconByValue } = React.useMemo(
        () => indexOptions(options),
        [options],
    );

    return (
        <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
            {values.map((value) => (
                <MultiSelectChip
                    key={value}
                    label={labelByValue.get(value) ?? value}
                    color={colorByValue.get(value)}
                    icon={iconByValue.get(value)}
                    onRemove={() => onRemove(value)}
                />
            ))}
        </span>
    );
}

export interface MultiSelectOptionListProps {
    /** Every pickable option, in display order. */
    readonly options: readonly MultiSelectComboboxOption[];
    /** The currently selected values, so each row can show its check. */
    readonly selectedValues: readonly string[];
    /** Toggles one value. The surface decides whether the list stays open (the popover does). */
    readonly onToggle: (value: string) => void;
    /** Copy for the no-matches state. */
    readonly emptyMessage?: string;
    /** Extra layout classes; the list is already capped and scrollable. */
    readonly className?: string;
}

/**
 * The searchable, check-marked option list. It MUST be rendered inside a `Command` (it uses cmdk's
 * list/empty/group/item primitives), which is exactly what both surfaces provide — the combobox wraps
 * it in the popover's `Command`, and the modal wraps it in its own `Command` with a search field.
 *
 * Each row's `CommandItem` value carries the label, the hidden keywords AND the unique option value,
 * so cmdk's built-in filter matches a label or an email while never collapsing two same-named people.
 * Picking toggles; the selected row shows its `Check` at full opacity, the rest keep a transparent one
 * so labels stay aligned.
 */
export function MultiSelectOptionList({
    options,
    selectedValues,
    onToggle,
    emptyMessage = "No matches.",
    className,
}: MultiSelectOptionListProps) {
    const selectedSet = React.useMemo(() => new Set(selectedValues), [selectedValues]);

    return (
        <CommandList
            className={cn("max-h-64 overflow-x-hidden overflow-y-auto overscroll-contain", className)}
            onWheel={(event) => event.stopPropagation()}
        >
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
                {options.map((option) => {
                    const checked = selectedSet.has(option.value);

                    return (
                        <CommandItem
                            key={option.value}
                            value={commandValueFor(option)}
                            keywords={commandKeywordsFor(option)}
                            onSelect={() => onToggle(option.value)}
                        >
                            <Check
                                className={cn(
                                    "mr-2 h-4 w-4 shrink-0",
                                    checked ? "opacity-100" : "opacity-0",
                                )}
                                aria-hidden="true"
                            />
                            {/*
                             * The list row is a bare surface, so the glyph takes `tone="status"` (the
                             * stored hex itself). It is always drawn — an option with no stored icon
                             * falls back to the foundation's default marker, keeping rows aligned.
                             */}
                            <CatalogStatusIcon
                                icon={option.icon}
                                color={option.color}
                                tone="status"
                                density="comfortable"
                            />
                            <span className="min-w-0 flex-1 truncate" title={option.label}>
                                {option.label}
                            </span>
                        </CommandItem>
                    );
                })}
            </CommandGroup>
        </CommandList>
    );
}

/**
 * The multiselect combobox: a chip trigger plus a searchable, staying-open option list.
 *
 * Picks KEEP the popover open (it is a toggle, not a pick-and-close), so several members can be added
 * or removed in one interaction. Backspace / Delete on the CLOSED trigger drops the last pick, the
 * clear (X) empties the whole selection when `clearable`, and an option's colour tints its chip and
 * its list icon.
 */
export function MultiSelectCombobox({
    options,
    values,
    onValuesChange,
    placeholder = "Select...",
    searchPlaceholder = "Search...",
    emptyMessage = "No matches.",
    ariaLabel,
    disabled = false,
    className,
    clearable = true,
}: MultiSelectComboboxProps) {
    const [open, setOpen] = React.useState(false);
    const hasSelection = values.length > 0;

    const toggle = React.useCallback(
        (value: string) => {
            onValuesChange(
                values.includes(value)
                    ? values.filter((current) => current !== value)
                    : [...values, value],
            );
        },
        [values, onValuesChange],
    );

    /** Backspace / Delete on the closed trigger removes the most recently added pick. */
    const removeLast = React.useCallback(() => {
        if (values.length > 0) onValuesChange(values.slice(0, -1));
    }, [values, onValuesChange]);

    const clearAll = React.useCallback(() => onValuesChange([]), [onValuesChange]);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    aria-label={ariaLabel}
                    className={cn(
                        "h-auto min-h-10 w-full min-w-0 max-w-full justify-between gap-2 py-1.5",
                        !hasSelection && "text-muted-foreground",
                        disabled && "cursor-not-allowed opacity-50",
                        className,
                    )}
                    disabled={disabled}
                    onKeyDown={(event) => {
                        if ((event.key === "Backspace" || event.key === "Delete") && !open) {
                            event.preventDefault();
                            removeLast();
                        }
                    }}
                >
                    {hasSelection ? (
                        <MultiSelectChipRow
                            options={options}
                            values={values}
                            onRemove={toggle}
                            className="flex-1 text-left"
                        />
                    ) : (
                        <span className="min-w-0 flex-1 truncate text-left">{placeholder}</span>
                    )}

                    {/*
                     * Clear-all, rendered only while a selection exists and the caller allows it. It
                     * sits after the flex-1 chip field so it trails the control, and its click stops
                     * propagation so emptying the selection never also toggles the popover.
                     */}
                    {clearable && hasSelection ? (
                        <span
                            role="button"
                            tabIndex={0}
                            data-slot="multi-select-combobox-clear"
                            aria-label={`Clear ${ariaLabel}`}
                            title={`Clear ${ariaLabel}`}
                            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-muted-foreground/20"
                            onClick={(event) => {
                                event.stopPropagation();
                                clearAll();
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    clearAll();
                                }
                            }}
                        >
                            <X className="size-3.5" aria-hidden="true" />
                        </span>
                    ) : null}

                    <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
                </Button>
            </PopoverTrigger>

            <PopoverContent
                className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] overflow-hidden p-0"
                align="start"
            >
                <Command>
                    <CommandInput placeholder={searchPlaceholder} />
                    <MultiSelectOptionList
                        options={options}
                        selectedValues={values}
                        onToggle={toggle}
                        emptyMessage={emptyMessage}
                    />
                </Command>
            </PopoverContent>
        </Popover>
    );
}

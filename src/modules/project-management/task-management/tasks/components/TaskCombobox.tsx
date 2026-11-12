"use client";

import * as React from "react";
import { Check, X } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import { CatalogStatusIcon } from "./CatalogStatusIcon";

/**
 * The ONE searchable single-select combobox for the project-management module.
 *
 * This is the module's shared "choose one row from a table" control and it owns its popup: Radix
 * Popover for the anchor and dismissal, `cmdk` for the search, the list and the keyboard model.
 * It is deliberately NOT built on `@/components/ui/combobox`, for the reason below.
 *
 * ## Why the popup is portalled into the modal, not into `<body>`
 *
 * The shared base-ui combobox portals its popup to `<body>`. A modal Radix dialog keeps focus
 * inside its own DOM subtree, so a popup outside it loses focus the moment it is focused (the
 * dialog's focus scope pulls it straight back to the first field) and, with `pointer-events: none`
 * on `body`, swallows every click. Both symptoms were live in the edit dialog: the search box could
 * be clicked but never typed into, and options could not be selected at all.
 *
 * `useModalContainer` resolves the dialog/sheet/alert-dialog the control is rendered inside, and the
 * popup is portalled into that element. Inside a modal the popup is then in the same subtree as the
 * dialog: focus is allowed to stay, pointer events are inherited, and no global CSS repair is needed.
 * Outside a modal the same code path portals to `<body>`, which keeps the popup clear of ancestors
 * that clip (`overflow-hidden` tables and card headers are everywhere in this module).
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

/** Keys that move cmdk's highlight, i.e. proof the reader picked a row on purpose. */
const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);

/** The three modal surfaces this module opens; their content elements are valid portal targets. */
const MODAL_CONTENT_SELECTOR =
    '[data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"]';

/**
 * The portalled popup element, exported so a caller that must tell "inside the list" from "outside
 * the control" reads the slot from here instead of hard-coding it — a stale copy of this string
 * made every inline cell editor cancel on pointer-down before the option's click could commit.
 */
export const TASK_COMBOBOX_POPUP_SELECTOR = '[data-slot="task-combobox-content"]';

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

    const [open, setOpen] = React.useState(false);
    /**
     * Whether the reader has moved the highlight since the popup opened.
     *
     * cmdk highlights the FIRST option as soon as the list exists — a cosmetic default, not a
     * choice — while the row that carries the check is the real value. Enter would therefore commit
     * the top option (verified: priority "high" reopened and Enter writes `priority_id` for "low"),
     * so an un-navigated Enter only closes, leaving the current value alone.
     */
    const [hasNavigated, setHasNavigated] = React.useState(false);
    /** The search text, so a typed query counts as intent even without an arrow key. */
    const [query, setQuery] = React.useState("");
    const [container, setContainer] = React.useState<HTMLElement | null>(null);
    const rootRef = React.useRef<HTMLDivElement>(null);
    /** Ties the trigger to the list for assistive tech: `combobox` requires both aria props. */
    const listId = React.useId();

    /**
     * Resolved when the popup OPENS rather than on mount: the control can be rendered before its
     * modal exists (a form field inside a dialog that has not mounted its content yet), and the
     * portal target has to be a live element at the moment the popup is created.
     */
    const handleOpenChange = React.useCallback(
        (next: boolean): void => {
            if (disabled) return;
            if (next) {
                const modal = rootRef.current?.closest(MODAL_CONTENT_SELECTOR);
                setContainer(modal instanceof HTMLElement ? modal : null);
                setHasNavigated(false);
                setQuery("");
            }
            setOpen(next);
        },
        [disabled],
    );

    const handleCommandKeyDown = React.useCallback((event: React.KeyboardEvent): void => {
        if (NAVIGATION_KEYS.has(event.key)) setHasNavigated(true);
    }, []);

    const handleInputKeyDown = React.useCallback(
        (event: React.KeyboardEvent): void => {
            if (event.key !== "Enter" || hasNavigated || query !== "") return;
            // Stop cmdk from selecting the default-highlighted first option.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
        },
        [hasNavigated, query],
    );

    const selectedLabel = value === null ? null : labels.get(value) ?? value;

    return (
        <div
            ref={rootRef}
            data-slot="task-combobox"
            className={cn(
                "relative flex h-9 w-full min-w-0 items-center rounded-md border border-input bg-transparent pr-1 shadow-xs transition-[color,box-shadow] outline-none dark:bg-input/30",
                "has-[:focus-visible]:border-ring has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]",
                disabled && "cursor-not-allowed opacity-50",
                className,
            )}
        >
            <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
                <PopoverPrimitive.Trigger asChild>
                    <button
                        type="button"
                        role="combobox"
                        aria-expanded={open}
                        aria-controls={open ? listId : undefined}
                        aria-haspopup="listbox"
                        aria-label={ariaLabel}
                        disabled={disabled}
                        className={cn(
                            "flex h-full min-w-0 flex-1 items-center gap-2 rounded-md bg-transparent px-3 text-left text-sm outline-none",
                            "disabled:cursor-not-allowed",
                            "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                        )}
                    >
                        {/*
                         * The selected value leads with its stored icon — the same glyph the read-only
                         * row chip shows — so opening the editor never changes what the value looks
                         * like. `tone="status"` because the trigger is a bare surface, not a filled
                         * pill. Skipped entirely when the caller has opted out: a list has no glyph
                         * to show, and the fallback marker would be a stray circle, not information.
                         */}
                        {value === null || !showStatusIcon ? null : (
                            <CatalogStatusIcon
                                icon={icons.get(value)}
                                color={colors.get(value)}
                                tone="status"
                                density="comfortable"
                            />
                        )}
                        <span
                            className={cn(
                                "min-w-0 flex-1 truncate",
                                value === null && "text-muted-foreground",
                            )}
                        >
                            {selectedLabel ?? placeholder}
                        </span>
                    </button>
                </PopoverPrimitive.Trigger>

                <PopoverPrimitive.Portal container={container ?? undefined}>
                    <PopoverPrimitive.Content
                        data-slot="task-combobox-content"
                        align="start"
                        sideOffset={4}
                        /*
                         * Inside a dialog the popup lives in the dialog's DOM, and a dialog clips its
                         * overflow — so the popup must be laid out to FIT the dialog rather than
                         * escape it. Collision is measured against the dialog box, which makes Radix
                         * flip the list above the trigger when there is no room below, and the list
                         * caps itself to the height Radix reports (see `CommandList` below).
                         */
                        collisionBoundary={container ?? undefined}
                        collisionPadding={8}
                        aria-label={`${ariaLabel} options`}
                        className={cn(
                            "z-[9999] w-(--radix-popover-trigger-width) min-w-(--radix-popover-trigger-width) overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-hidden",
                            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
                        )}
                    >
                        <Command loop onKeyDown={handleCommandKeyDown}>
                            <CommandInput
                                placeholder={searchPlaceholder}
                                aria-label={`Search ${ariaLabel}`}
                                value={query}
                                onValueChange={setQuery}
                                onKeyDown={handleInputKeyDown}
                            />
                            <CommandList
                                id={listId}
                                // Radix reports how much room the popup has inside its collision
                                // boundary; the search field above takes the rest, so the list
                                // scrolls instead of growing past the dialog's edge.
                                style={{
                                    maxHeight:
                                        "calc(var(--radix-popover-content-available-height) - 2.75rem)",
                                }}
                            >
                                <CommandEmpty>{emptyMessage}</CommandEmpty>
                                <CommandGroup>
                                    {options.map((option) => (
                                        <CommandItem
                                            key={option.value}
                                            // cmdk filters on `value` plus `keywords`; the id keeps
                                            // selection unambiguous while the label stays searchable.
                                            value={option.value}
                                            keywords={[option.label]}
                                            onSelect={() => {
                                                onValueChange(option.value);
                                                setOpen(false);
                                            }}
                                            className="gap-2"
                                        >
                                            {/*
                                             * The glyph is ALWAYS drawn for a catalog: an option with no
                                             * stored icon falls back to the foundation's default marker, so
                                             * the option column stays uniform. A non-catalog row set opts
                                             * out (`showStatusIcon={false}`) so its rows are plain text.
                                             */}
                                            {showStatusIcon ? (
                                                <CatalogStatusIcon
                                                    icon={icons.get(option.value)}
                                                    color={colors.get(option.value)}
                                                    tone="status"
                                                    density="comfortable"
                                                />
                                            ) : null}
                                            <span className="min-w-0 flex-1 truncate">
                                                {option.label}
                                            </span>
                                            {option.value === value ? (
                                                <Check
                                                    className="size-3.5 shrink-0 text-primary"
                                                    aria-hidden="true"
                                                />
                                            ) : null}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            </CommandList>
                        </Command>
                    </PopoverPrimitive.Content>
                </PopoverPrimitive.Portal>
            </PopoverPrimitive.Root>

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
    );
}

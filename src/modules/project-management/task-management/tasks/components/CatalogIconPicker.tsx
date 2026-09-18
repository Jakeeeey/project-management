"use client";

import { useState } from "react";
import { Ban, Check, ChevronsUpDown } from "lucide-react";

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

import { resolveCatalogHex } from "./CatalogChip";
import { CatalogStatusIcon } from "./CatalogStatusIcon";
import { CATALOG_ICON_GROUPS, normalizeIconName } from "./catalog-icon";

/**
 * The ONE icon picker for the project-management module.
 *
 * A status, a priority and a custom-field option all store the same kind of value: a kebab-case name
 * from `catalog-icon.ts`'s closed allow-list. This control is how an administrator chooses one.
 *
 * ## Why a searchable popover and not a plain dropdown
 *
 * The house rule is: a list from a database table is a searchable combobox, a short preconfigured
 * enum is a plain dropdown — and a LONG predefined list is still searchable, because the item count,
 * not the source, is what makes scrolling painful. The allow-list offers 44 icons across five
 * lifecycle groups, so it is a searchable `Popover` + `Command`, built exactly like
 * `MultiSelectCombobox` (same primitives, same trigger/keyboard conventions) rather than a new
 * pattern.
 *
 * ## Truthful previews
 *
 * The stored glyph is real and is drawn on a swatch filled with the CURRENTLY CHOSEN colour, so what
 * the administrator sees here is what the chip will look like. `tone="contrast"` is used wherever
 * the glyph sits on that solid fill (the list rows and the trigger's selection) and `tone="status"`
 * where it does not (a colourless swatch), matching the chip's own legibility rule.
 *
 * ## Contract
 *
 * Fully controlled and presentational: the caller owns `value`, this component never fetches. `value`
 * is a raw stored string — it is resolved through `normalizeIconName`, so an unknown or malformed
 * value reads as "No icon" instead of throwing, and `onChange(null)` is always offered so an icon is
 * never mandatory.
 */

export interface CatalogIconPickerProps {
    /** The raw stored icon name, or `null` for none. Resolved through `normalizeIconName`. */
    readonly value: string | null;
    /** Receives the next allow-listed icon name, or `null` when the clear row is used. */
    readonly onChange: (next: string | null) => void;
    /** The colour the row currently holds, so every glyph previews in its true final ink. */
    readonly color?: string | null;
    readonly disabled?: boolean;
    /** Applied to the trigger so a `FormLabel htmlFor` can name the control. */
    readonly id?: string;
}

/** Shown in the trigger, and as the clear row's label, while no icon is chosen. */
const NO_ICON_LABEL = "No icon";

/**
 * The clear row's cmdk identity. A sentinel beginning with a character no allow-listed name contains,
 * so "clear" can never be mistaken for a real icon during filtering.
 */
const CLEAR_ITEM_VALUE = "__none__";

/** Extra search terms for the clear row, so "none", "clear" and "empty" all reach it. */
const CLEAR_ITEM_KEYWORDS = ["none", "clear", "empty", "no icon"];

/**
 * The dashed placeholder swatch the trigger shows while nothing is chosen — a slot that is visibly
 * empty rather than a blank gap, so "No icon" reads as a deliberate state.
 */
function EmptySwatch() {
    return (
        <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"
        >
            <Ban className="size-3.5" />
        </span>
    );
}

export interface IconSwatchProps {
    /** An allow-listed icon name, already resolved. */
    readonly name: string;
    /** The chosen colour; a malformed or absent value leaves the swatch neutral and unfilled. */
    readonly color: string | null;
}

/**
 * One glyph on a solid swatch filled with the chosen colour.
 *
 * The fill and the ink are the SAME decision the chip makes (`resolveCatalogHex` +
 * `CatalogStatusIcon`), so a preview can never disagree with the badge it is choosing for. A colour
 * that does not parse leaves the swatch unfilled and the glyph in the inherited ink (`tone="status"`)
 * rather than painting a black `#000000`-ish fill on the strength of garbage.
 */
function IconSwatch({ name, color }: IconSwatchProps) {
    const hex = resolveCatalogHex(color);

    return (
        <span
            aria-hidden="true"
            className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-md",
                hex === null && "border border-border bg-muted/40",
            )}
            style={hex === null ? undefined : { backgroundColor: hex }}
        >
            <CatalogStatusIcon
                icon={name}
                color={color}
                tone={hex === null ? "status" : "contrast"}
                density="dense"
            />
        </span>
    );
}

export function CatalogIconPicker({
    value,
    onChange,
    color = null,
    disabled = false,
    id,
}: CatalogIconPickerProps) {
    const [open, setOpen] = useState(false);

    /** A stored value outside the allow-list resolves to `null` — the same as no icon, never a throw. */
    const selected = normalizeIconName(value);
    const hex = resolveCatalogHex(color);

    const choose = (next: string | null): void => {
        onChange(next);
        // A single pick is pick-and-close; the clear row closes the same way.
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    id={id}
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    aria-label="Icon"
                    data-slot="catalog-icon-picker"
                    disabled={disabled}
                    className={cn(
                        "h-9 w-full min-w-0 justify-between gap-2 px-3 font-normal",
                        selected === null && "text-muted-foreground",
                        disabled && "cursor-not-allowed opacity-50",
                    )}
                >
                    {/*
                     * The selection is the glyph plus its name, both truncating inside the control's
                     * flexible middle so a long name can never widen the trigger.
                     */}
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        {selected === null ? (
                            <EmptySwatch />
                        ) : (
                            <IconSwatch name={selected} color={color} />
                        )}
                        <span className="min-w-0 truncate">{selected ?? NO_ICON_LABEL}</span>
                    </span>

                    <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
                </Button>
            </PopoverTrigger>

            <PopoverContent
                className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] overflow-hidden p-0"
                align="start"
            >
                <Command>
                    <CommandInput placeholder="Search icons..." aria-label="Search icons" />
                    <CommandList
                        className="max-h-64"
                        onWheel={(event) => event.stopPropagation()}
                    >
                        <CommandEmpty>No matching icon.</CommandEmpty>

                        {/*
                         * The explicit clear row: an icon is optional, so "no icon" has to be
                         * pickable and not merely the absence of a click.
                         */}
                        <CommandGroup>
                            <CommandItem
                                value={CLEAR_ITEM_VALUE}
                                keywords={CLEAR_ITEM_KEYWORDS}
                                onSelect={() => choose(null)}
                            >
                                <EmptySwatch />
                                <span className="min-w-0 flex-1 truncate">{NO_ICON_LABEL}</span>
                                <Check
                                    className={cn(
                                        "size-4",
                                        selected === null ? "opacity-100" : "opacity-0",
                                    )}
                                    aria-hidden="true"
                                />
                            </CommandItem>
                        </CommandGroup>

                        {CATALOG_ICON_GROUPS.map((group) => (
                            <CommandGroup
                                key={group.group}
                                heading={
                                    hex === null ? (
                                        group.group
                                    ) : (
                                        <span style={{ color: hex }}>{group.group}</span>
                                    )
                                }
                            >
                                {group.names.map((name) => (
                                    <CommandItem
                                        key={name}
                                        value={name}
                                        keywords={[group.group]}
                                        onSelect={() => choose(name)}
                                    >
                                        <IconSwatch name={name} color={color} />
                                        <span className="min-w-0 flex-1 truncate">{name}</span>
                                        <Check
                                            className={cn(
                                                "size-4",
                                                name === selected ? "opacity-100" : "opacity-0",
                                            )}
                                            aria-hidden="true"
                                        />
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        ))}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}

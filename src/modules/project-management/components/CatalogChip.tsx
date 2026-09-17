import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/**
 * A status or priority catalog row as a chip renders it.
 *
 * Both fields are DATA: `label` is whatever an administrator typed into the department's catalog
 * and `color` is that row's stored colour. Nothing here maps an id to a name, because a hardcoded
 * status/priority map is exactly what the plan forbids — the catalog is the runtime source of
 * truth and a task references it by foreign key.
 */
export interface CatalogChipValue {
    /** Catalog row label, rendered verbatim. */
    readonly label: string;
    /** 6-digit hex from the catalog's `color` column, or `null`/`undefined` for no stored colour. */
    readonly color?: string | null;
}

/**
 * The two fixed chip geometries. Every chip on a surface uses the same one.
 *
 * `dense` is the tree table's status/priority cells (`text-[11px] font-semibold`, 20px tall);
 * `comfortable` is the detail sheet, the drag overlay and the configuration list (`text-xs`, 24px).
 */
export type CatalogChipDensity = "dense" | "comfortable";

/** Catalogue colours are user-chosen data; only a plain 6-digit hex is applied as a tint. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** A trimmed, non-blank label — the only thing that makes a chip "real" rather than a placeholder. */
function readLabel(value: CatalogChipValue | null | undefined): string | null {
    const label = value?.label?.trim();
    return label === undefined || label === "" ? null : label;
}

/** A 6-digit hex as stored, or `null` for blank / malformed / absent values. */
export function resolveCatalogHex(color: string | null | undefined): string | null {
    return typeof color === "string" && HEX_COLOR_PATTERN.test(color) ? color : null;
}

/**
 * Turns a catalog row's stored hex into the chip's inline tint.
 *
 * A CSS custom property / inline style is used instead of a Tailwind class because a class literal
 * cannot express an arbitrary user-chosen colour. Mixing the colour toward `transparent` for the
 * fill and toward the theme foreground for the text keeps the chip legible in both light and dark
 * mode without ever hardcoding `bg-white` / `text-slate-*`.
 *
 * `hsl(var(--foreground))` — NOT the bare `var(--foreground)` — is required: the raw variable holds
 * an HSL triplet (`240 10% 3.9%`), which is not a valid `<color>` for `color-mix` and would silently
 * void the whole declaration, leaving the chip untinted.
 */
function catalogTint(color: string): CSSProperties {
    return {
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
        color: `color-mix(in srgb, ${color} 65%, hsl(var(--foreground)))`,
    };
}

/** The foreground halo that keeps a very dark or very light dot visible on either theme. */
const DOT_HALO = "0 0 0 1px color-mix(in srgb, hsl(var(--foreground)) 15%, transparent)";

/** One geometry per density: identical height, gap, padding and text size. */
const CHIP_DENSITY_CLASS: Record<CatalogChipDensity, string> = {
    dense: "h-5 gap-1.5 px-2 text-[11px] font-semibold",
    comfortable: "h-6 gap-1.5 px-2.5 text-xs font-medium",
};

const DOT_DENSITY_CLASS: Record<CatalogChipDensity, string> = {
    dense: "size-1.5",
    comfortable: "size-2",
};

export interface CatalogChipDotProps {
    /** Stored 6-digit hex; anything else renders the neutral dot. */
    readonly color?: string | null;
    readonly density?: CatalogChipDensity;
    readonly className?: string;
}

/**
 * The chip's leading dot — one implementation, shared by the chip and by every catalog option row.
 *
 * The fill is the catalog row's stored colour so a dense status column reads at a glance; a faint
 * foreground halo gives the dot an edge on both themes even when the colour itself is very dark or
 * very light. A row with no stored colour gets a neutral dot rather than a missing one. The dot is
 * decorative: the label carries the meaning for assistive technology.
 */
export function CatalogChipDot({ color, density = "dense", className }: CatalogChipDotProps) {
    const hex = resolveCatalogHex(color);

    return (
        <span
            data-slot="catalog-chip-dot"
            aria-hidden="true"
            className={cn(
                "inline-block shrink-0 rounded-full",
                DOT_DENSITY_CLASS[density],
                hex === null && "border border-muted-foreground/50 bg-muted-foreground/20",
                className,
            )}
            style={hex === null ? undefined : { backgroundColor: hex, boxShadow: DOT_HALO }}
        />
    );
}

export interface CatalogChipProps {
    /**
     * The resolved catalog reference. `null`/`undefined`/a blank label renders the muted placeholder
     * — never a blank chip and never a stale label.
     */
    readonly value?: CatalogChipValue | null;
    /** The neutral copy for an unresolved reference ("No status assigned yet" / "No priority set"). */
    readonly placeholder?: string;
    readonly density?: CatalogChipDensity;
    /** The truncation cap (`max-w-*`), merged last so a call site owns its cell's width. */
    readonly className?: string;
    /** Stable selection hook; the row cells pass `task-status-badge` / `task-priority-badge`. */
    readonly "data-slot"?: string;
}

/**
 * The ONE status/priority chip for the project-management module.
 *
 * A leading dot carrying the catalog row's stored colour plus the label, in a fixed geometry per
 * density. A resolved row tints the chip from its own hex; a row with no stored colour keeps the
 * neutral border; an unresolved reference renders the dashed, muted placeholder so a broken foreign
 * key reads as intentional rather than as a rendering bug.
 *
 * The label truncates inside the caller's `max-w-*` cap (with `title` for the full text), so a long
 * catalog label can never push its column wider. Purely presentational: no state, no fetching.
 */
export function CatalogChip({
    value,
    placeholder = "Not set",
    density = "dense",
    className,
    "data-slot": dataSlot = "catalog-chip",
}: CatalogChipProps) {
    const label = readLabel(value);

    if (label === null) {
        return (
            <span
                data-slot={dataSlot}
                data-placeholder="true"
                data-density={density}
                title={placeholder}
                className={cn(
                    "inline-flex max-w-full items-center rounded-full border border-dashed border-border bg-muted/30 text-muted-foreground",
                    CHIP_DENSITY_CLASS[density],
                    className,
                )}
            >
                <CatalogChipDot density={density} />
                <span className="min-w-0 truncate font-normal">{placeholder}</span>
            </span>
        );
    }

    const hex = resolveCatalogHex(value?.color);

    return (
        <span
            data-slot={dataSlot}
            data-placeholder="false"
            data-density={density}
            title={label}
            style={hex === null ? undefined : catalogTint(hex)}
            className={cn(
                "inline-flex max-w-full items-center rounded-full border",
                CHIP_DENSITY_CLASS[density],
                hex === null && "border-border bg-muted/40 text-foreground",
                className,
            )}
        >
            <CatalogChipDot color={hex} density={density} />
            <span className="min-w-0 truncate">{label}</span>
        </span>
    );
}

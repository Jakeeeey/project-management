import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import { CatalogStatusIcon } from "./CatalogStatusIcon";

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
    /** Allow-listed lucide icon name from the catalog's `icon` column, or `null`/`undefined` for none. */
    readonly icon?: string | null;
}

/**
 * The two fixed chip geometries. Every chip on a surface uses the same one.
 *
 * `dense` is the tree table's status/priority cells (`text-[11px] font-semibold`, 28px tall);
 * `comfortable` is the custom-column settings and the configuration list (`text-xs`, 32px).
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
 * Relative luminance (WCAG 2.x) of a stored hex, or `null` when the value is not a `#rrggbb`.
 *
 * Each channel is normalised to `[0, 1]`, converted from sRGB to linear light and weighted by the
 * eye's sensitivity (`0.2126 R + 0.7152 G + 0.0722 B`). This is the ONE number that says how bright
 * a catalog colour actually is — the raw hex cannot, because `#f59e0b` and `#2563eb` are both
 * saturated yet one is roughly three times brighter than the other.
 *
 * Exported (and pure) so the foreground decision below is testable without rendering a chip.
 */
export function catalogHexLuminance(color: string): number | null {
    const hex = resolveCatalogHex(color);
    if (hex === null) {
        return null;
    }

    const channel = (offset: number): number => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Near-black rather than `#000`, so a solid chip reads as ink instead of a punched-out hole. */
const CHIP_FOREGROUND_DARK = "#0a0a0a";

/** White label on a dark fill; the fallback for a colour that cannot be parsed. */
const CHIP_FOREGROUND_LIGHT = "#ffffff";

/**
 * The lightness above which a fill reads as "light" and needs dark text.
 *
 * Applied to the luminance's square root, not the raw value: WCAG luminance is not perceptually
 * uniform (mid-tones cluster near the top), so `sqrt` spreads it into a lightness where a plain
 * `0.5` is the right cut. On the raw value a `0.5` threshold would leave WHITE text on amber
 * (`#f59e0b`, L ~ 0.44) and green (`#16a34a`, L ~ 0.27) — exactly the colours where a fixed white
 * foreground is unreadable. An unparseable colour falls back to white rather than throwing, so a
 * bad catalog row can never break a render.
 */
const LIGHT_FILL_LUMINANCE_THRESHOLD = 0.5;

/**
 * The label colour that stays legible on a fill of the given stored hex: near-black on a light
 * colour, white on a dark one. Never throws — an unparseable value resolves to white.
 */
export function resolveCatalogForeground(color: string): string {
    const luminance = catalogHexLuminance(color);
    if (luminance === null) {
        return CHIP_FOREGROUND_LIGHT;
    }

    return Math.sqrt(luminance) > LIGHT_FILL_LUMINANCE_THRESHOLD
        ? CHIP_FOREGROUND_DARK
        : CHIP_FOREGROUND_LIGHT;
}

/**
 * Turns a catalog row's stored hex into the chip's inline SOLID fill.
 *
 * A CSS custom property / inline style is used instead of a Tailwind class because a class literal
 * cannot express an arbitrary user-chosen colour: a runtime hex can never become a `bg-*` class.
 * The fill is the stored colour at FULL strength, the edge is left transparent so the pill reads as
 * one solid shape with no lightened rim, and the label takes whichever of near-black / white
 * `resolveCatalogForeground` proves legible on that specific fill.
 */
export function catalogSolidStyle(color: string): CSSProperties {
    return {
        backgroundColor: color,
        borderColor: "transparent",
        color: resolveCatalogForeground(color),
    };
}

/** The foreground halo that keeps a very dark or very light dot visible on either theme. */
const DOT_HALO = "0 0 0 1px color-mix(in srgb, hsl(var(--foreground)) 15%, transparent)";

/**
 * One geometry per density: identical SHAPE, gap, padding and text size.
 *
 * The shape is a rounded rectangle, never a pill, and the radius lives HERE rather than in a render
 * branch so the resolved chip and the dashed placeholder can never take different shapes.
 * `rounded-md` matches the buttons, pickers and inputs the chip sits among; at these heights a
 * fully-rounded cap would read as a lozenge that ignores the row it fills.
 *
 * Heights are measured against the surfaces' own rows:
 * - `dense` (28px) is the tree table's status/priority cell. That row is 48px — its tallest cell is
 *   the actions column's 32px `icon-sm` button plus the shared `TableCell`'s `p-2` (16px) — so a
 *   28px chip fills most of that 32px content box while the cell padding keeps the breathing room,
 *   and it can never grow the row (28 + 16 < 48).
 * - `comfortable` (32px) is the configuration list and the custom-column settings, whose rows are
 *   ALSO 48px (a 32px `icon-sm` control plus the same `py-2`), so it matches its own row exactly
 *   without overflowing it.
 */
const CHIP_DENSITY_CLASS: Record<CatalogChipDensity, string> = {
    dense: "h-7 gap-1.5 rounded-md px-2 text-[11px] font-semibold",
    comfortable: "h-8 gap-1.5 rounded-md px-2.5 text-xs font-medium",
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
 * A resolved row is a SOLID rounded rectangle: the fill is the catalog row's own hex at full
 * strength, the edge is transparent, the leading glyph is the row's stored icon inked for contrast,
 * and the label takes whichever of near-black / white stays legible (see `resolveCatalogForeground`),
 * uppercase and letter-spaced. A row with no stored colour keeps the neutral border but still shows
 * that icon — a missing icon falls back to a circle rather than vanishing, so every resolved chip
 * reads the same; an unresolved reference renders the dashed, muted placeholder so a broken foreign
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
                    "inline-flex max-w-full items-center border border-dashed border-border bg-muted/30 text-muted-foreground",
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
            style={hex === null ? undefined : catalogSolidStyle(hex)}
            className={cn(
                "inline-flex max-w-full items-center border",
                CHIP_DENSITY_CLASS[density],
                hex === null && "border-border bg-muted/40 text-foreground",
                className,
            )}
        >
            {/* Solid fill and muted both lead with the stored icon: it is the row's identity, and a
                uniform glyph keeps the status/priority columns from shifting between the two. */}
            <CatalogStatusIcon icon={value?.icon} color={hex} tone="contrast" density={density} />
            <span className="min-w-0 truncate uppercase tracking-wide">{label}</span>
        </span>
    );
}

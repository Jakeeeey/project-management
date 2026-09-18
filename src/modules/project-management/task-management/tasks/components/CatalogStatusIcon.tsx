"use client";

import type { JSX } from "react";
import {
    Activity,
    Archive,
    BadgeCheck,
    Check,
    CheckCheck,
    Circle,
    CircleAlert,
    CircleArrowUp,
    CircleCheck,
    CircleCheckBig,
    CircleDashed,
    CircleDot,
    CircleDotDashed,
    CircleEllipsis,
    CircleFadingArrowUp,
    CircleGauge,
    CircleMinus,
    CircleOff,
    CirclePause,
    CirclePercent,
    CirclePlay,
    CirclePower,
    CircleQuestionMark,
    CircleSlash,
    CircleStar,
    CircleStop,
    CircleX,
    Clock,
    Eye,
    Flag,
    Hourglass,
    LoaderCircle,
    MessageCircle,
    OctagonAlert,
    Rocket,
    ScanSearch,
    Search,
    ShieldCheck,
    Sparkles,
    SquareDashed,
    Target,
    TriangleAlert,
    Trophy,
    Verified,
    type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { resolveCatalogForeground, resolveCatalogHex } from "./CatalogChip";
import { DEFAULT_CATALOG_ICON, normalizeIconName } from "./catalog-icon";

/**
 * The one renderer for a catalog row's stored icon — status, priority or custom-field option.
 *
 * The stored value is a kebab-case name from `catalog-icon.ts`'s allow-list; this component owns the
 * only place that maps such a name to a drawing. The map is built from STATIC imports (never a
 * dynamic `import()` or an index lookup from a package) so the bundler can see every icon the
 * module can render and tree-shake the rest of lucide-react away.
 *
 * A garbage stored value is not an error: `normalizeIconName` resolves it to `null` and the render
 * falls back — to the caller's `fallback`, then to `DEFAULT_CATALOG_ICON` — so a bad row can never
 * throw a client component.
 */
export interface CatalogStatusIconProps {
    /** Raw stored icon name; anything unresolvable falls back. */
    readonly icon?: unknown;
    /** The catalog row's stored 6-digit hex, or null. */
    readonly color?: string | null;
    /** "contrast" = inside the chip's solid fill; "status" = bare, on the row background. */
    readonly tone?: "status" | "contrast";
    readonly density?: "dense" | "comfortable";
    readonly className?: string;
    readonly fallback?: string;
}

/**
 * The allow-list's drawings, keyed by the same kebab-case names the database stores.
 *
 * The map is exhaustive: every name in `CATALOG_ICON_NAMES` appears below, so indexing it with the
 * output of `normalizeIconName` (which can only return an allow-listed name) is total. Adding a name
 * to the allow-list without adding its drawing here is the one edit that breaks this invariant.
 */
const CATALOG_ICONS: Record<string, LucideIcon> = {
    "circle": Circle,
    "circle-dashed": CircleDashed,
    "circle-dot": CircleDot,
    "circle-ellipsis": CircleEllipsis,
    "circle-question-mark": CircleQuestionMark,
    "square-dashed": SquareDashed,
    "circle-dot-dashed": CircleDotDashed,
    "loader-circle": LoaderCircle,
    "circle-play": CirclePlay,
    "circle-arrow-up": CircleArrowUp,
    "circle-fading-arrow-up": CircleFadingArrowUp,
    "circle-gauge": CircleGauge,
    "circle-percent": CirclePercent,
    "activity": Activity,
    "circle-alert": CircleAlert,
    "triangle-alert": TriangleAlert,
    "octagon-alert": OctagonAlert,
    "circle-slash": CircleSlash,
    "circle-x": CircleX,
    "circle-off": CircleOff,
    "circle-pause": CirclePause,
    "circle-stop": CircleStop,
    "clock": Clock,
    "hourglass": Hourglass,
    "circle-minus": CircleMinus,
    "eye": Eye,
    "search": Search,
    "scan-search": ScanSearch,
    "circle-check-big": CircleCheckBig,
    "shield-check": ShieldCheck,
    "verified": Verified,
    "message-circle": MessageCircle,
    "sparkles": Sparkles,
    "circle-star": CircleStar,
    "circle-check": CircleCheck,
    "check": Check,
    "check-check": CheckCheck,
    "badge-check": BadgeCheck,
    "circle-power": CirclePower,
    "archive": Archive,
    "trophy": Trophy,
    "rocket": Rocket,
    "flag": Flag,
    "target": Target,
};

/**
 * One icon geometry per density; both align with the chip heights they sit beside.
 *
 * Sized a step above lucide's own default so a bare status mark reads as a deliberate glyph rather
 * than a stray hairline: `size-4` (16px) inside the 28px dense chip and `size-5` (20px) inside the
 * 32px comfortable one. Neither can exceed the chip it sits in, so the glyph never grows the row.
 */
const ICON_SIZE_CLASS: Record<"dense" | "comfortable", string> = {
    dense: "size-4",
    comfortable: "size-5",
};

/**
 * The stroke weight shared by every catalog glyph, in both tones.
 *
 * lucide draws its outlines at `stroke-width: 2`; at 16-20px those hairlines read thin against a
 * chip's solid fill, so every mark is raised to 2.5. One constant keeps the tones — and every call
 * site (tree, chips, picker, field cells) — visually identical; only the colour source differs.
 */
const CATALOG_ICON_STROKE_WIDTH = 2.5;

/** White is the contrast tone's fallback: it is the one ink guaranteed to read on an unknown fill. */
const CONTRAST_FALLBACK_COLOR = "#ffffff";

/**
 * Draws one catalog icon.
 *
 * Both tones render the SAME outline glyph at the same size and stroke weight: lucide is a stroke
 * set (`fill: none`), so every mark is an outline by construction, never a filled disc. Only the
 * colour source differs:
 * - `contrast` — inside the chip's own SOLID fill: the glyph takes the same legibility-derived
 *   foreground the chip's label uses, so it stays readable on an arbitrary catalog colour.
 * - `status` — bare, on a row/list background: the glyph is inked in the row's own stored hex, or
 *   inherits `currentColor` when there is no stored colour, so a bare status reads as an outline.
 *
 * Colour is applied as an inline style and never as a Tailwind class: a runtime hex cannot become a
 * `text-*` class (the same rule `CatalogChip.tsx` documents). `size-*` and `shrink-0` stay classes
 * because they are static. The icon is decorative (`aria-hidden`): the label beside it already
 * carries the meaning for assistive technology, and a duplicated icon name would only add noise.
 */
export function CatalogStatusIcon({
    icon,
    color,
    tone = "status",
    density = "dense",
    className,
    fallback,
}: CatalogStatusIconProps): JSX.Element {
    const name = normalizeIconName(icon) ?? normalizeIconName(fallback) ?? DEFAULT_CATALOG_ICON;
    const Icon = CATALOG_ICONS[name];

    const hex = resolveCatalogHex(color);

    if (tone === "contrast") {
        return (
            <Icon
                aria-hidden="true"
                className={cn("shrink-0", ICON_SIZE_CLASS[density], className)}
                strokeWidth={CATALOG_ICON_STROKE_WIDTH}
                style={{
                    color: hex === null ? CONTRAST_FALLBACK_COLOR : resolveCatalogForeground(hex),
                }}
            />
        );
    }

    // Bare status: the same outline, inked in the stored hex; with no stored colour the glyph
    // inherits `currentColor` rather than guessing one.
    return (
        <Icon
            aria-hidden="true"
            className={cn("shrink-0", ICON_SIZE_CLASS[density], className)}
            strokeWidth={CATALOG_ICON_STROKE_WIDTH}
            style={hex === null ? undefined : { color: hex }}
        />
    );
}

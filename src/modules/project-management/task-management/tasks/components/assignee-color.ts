import { resolveCatalogForeground } from "./CatalogChip";

/**
 * The ONE place that turns a user id into an assignee's colour.
 *
 * The module has no `colour` column and never wants one: an assignee's colour is a presentation
 * detail, not department data, so requesting DDL or storing it would be the wrong trade. Instead the
 * colour is DERIVED from the id the assignee row already carries — the same derivation everywhere, so
 * the multi-select combobox, the task table's avatar stack and (later) the on-table cell editor all
 * agree on a member's colour without any of them sharing state.
 *
 * ## Why the mapping is a hash and not the list index
 *
 * Colour MUST be stable per person: the same user has to keep the same colour on every render, in
 * every session and on every client, and it must not move when the member's position in an
 * assignment list changes. Indexing by the person's position in the currently-visible list would do
 * exactly the wrong thing — assigning someone else must never repaint the people already assigned.
 *
 * The mapping below is therefore a pure function of `userId` alone:
 *
 * 1. take the id's magnitude (ids are positive integers, but a malformed value must not throw),
 * 2. mix it with Knuth's multiplicative constant inside a 32-bit integer multiply (`Math.imul`, so
 *    the result can never drift into floating-point rounding and is identical on every engine),
 * 3. read the palette at `mix % palette.length`.
 *
 * The multiply is what makes a *handful* of assignees look different. Plain `userId % length` walks
 * the palette one entry at a time, so ids 1, 2 and 3 land on adjacent hues (red / orange / amber) that
 * read as one colour; the multiply scatters them across the whole hue wheel instead.
 *
 * ## Dependency-free by design
 *
 * This file imports exactly one thing — `resolveCatalogForeground`, the module's existing WCAG
 * contrast resolver — and has no side effects, no React, and no Directus. That keeps the palette a
 * plain value and the mapping a plain function, so both are trivially assertable in isolation.
 */

/**
 * The curated assignee palette, ordered lightest-hue-cycle first.
 *
 * Every entry is a 6-digit hex, saturated and dark enough that the near-white foreground
 * `resolveCatalogForeground` picks on these fills is legible (the resolver still decides per colour,
 * so a future palette entry that is genuinely light degrades to dark ink rather than to unreadable
 * white). Hues are spread across the wheel rather than grouped by Tailwind family, so any two picks
 * are as far apart on the wheel as the palette allows.
 */
export const ASSIGNEE_COLOR_PALETTE: readonly string[] = [
    "#dc2626", // red
    "#0d9488", // teal
    "#7c3aed", // violet
    "#ea580c", // orange
    "#2563eb", // blue
    "#16a34a", // green
    "#c026d3", // fuchsia
    "#0891b2", // cyan
    "#b45309", // amber (a darker step; the 600 tone is too light for white text)
    "#4f46e5", // indigo
    "#db2777", // pink
    "#4d7c0f", // lime (a darker step for the same reason as amber)
    "#0284c7", // sky
    "#9333ea", // purple
    "#e11d48", // rose
    "#059669", // emerald
];

/** The palette length as a named constant, so the modulo reads as "index into the palette". */
const PALETTE_SIZE = ASSIGNEE_COLOR_PALETTE.length;

/**
 * The colour a non-finite id resolves to. `Number.isFinite` is checked before the mix so a `NaN` or
 * `Infinity` id (a malformed join, a hand-edited payload) yields a real palette entry rather than the
 * `undefined` that `palette[NaN]` would produce. The first entry is as good as any.
 */
const FALLBACK_COLOR = ASSIGNEE_COLOR_PALETTE[0];

/** Knuth's 32-bit multiplicative hash constant; coprime with any small palette, so it never repeats. */
const HASH_MULTIPLIER = 2654435761;

/**
 * The assignee's stable colour for `userId` — one of {@link ASSIGNEE_COLOR_PALETTE}'s 6-digit hexes.
 *
 * Deterministic by construction: it reads nothing but its argument, calls no clock or RNG, and its
 * only arithmetic is 32-bit integer multiplication, so every client and every session agrees. A
 * non-finite id falls back to the first palette entry instead of throwing.
 */
export function assigneeColorFor(userId: number): string {
    if (!Number.isFinite(userId)) {
        return FALLBACK_COLOR;
    }

    const magnitude = Math.abs(Math.trunc(userId));
    // `>>> 0` reinterprets the signed 32-bit product as unsigned, so the modulo is always in range.
    const hashed = Math.imul(magnitude, HASH_MULTIPLIER) >>> 0;
    return ASSIGNEE_COLOR_PALETTE[hashed % PALETTE_SIZE];
}

/**
 * The label/icon colour that stays legible on {@link assigneeColorFor}'s fill.
 *
 * Deliberately NOT a new contrast algorithm: it delegates to `CatalogChip`'s `resolveCatalogForeground`,
 * the module's single WCAG luminance decision, so an assignee chip and a status chip can never
 * disagree about what "readable on a solid fill" means. Takes the fill (not the id) so it also works
 * on a colour read back from anywhere.
 */
export function assigneeForegroundFor(color: string): string {
    return resolveCatalogForeground(color);
}

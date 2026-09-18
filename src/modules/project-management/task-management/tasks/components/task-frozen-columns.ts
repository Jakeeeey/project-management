/**
 * The task table's frozen leading columns: the expand gutter and the task title, pinned to the left
 * edge and scrolling together as ONE block.
 *
 * The pair is frozen together on purpose. The chevron carries the collapse/expand state and the title
 * cell carries the depth indentation, so freezing the title without its chevron would orphan the
 * tree's own affordance from the row it acts on.
 *
 * The offsets are NOT constants. The table is `table-fixed` and every column's width is a runtime
 * number the user can drag (see `task-column-widths.ts`), so each frozen column's `left` is the
 * CUMULATIVE width of the frozen columns before it, resolved from the same `widthFor` the
 * `<colgroup>` uses. Frozen geometry and actual column geometry therefore cannot disagree; a
 * hardcoded `left` would break silently the moment a frozen column was resized.
 *
 * Runtime offsets are applied as INLINE STYLES, never Tailwind classes — an arbitrary number can
 * never become a class literal (the same rule the catalog colours follow in `CatalogChip.tsx`). The
 * surface treatment of a frozen cell IS static, so it lives in the class tokens below.
 */

/** The frozen columns, in table order; the first pins at `left: 0`. */
export const FROZEN_TASK_COLUMN_KEYS = ["expand", "title"] as const;

export type FrozenTaskColumnKey = (typeof FROZEN_TASK_COLUMN_KEYS)[number];

/** Per-frozen-column `left` offset in pixels, resolved from the live column widths. */
export type FrozenTaskColumnOffsets = Readonly<Record<FrozenTaskColumnKey, number>>;

/** True for a column key that is pinned to the left edge. */
export function isFrozenTaskColumnKey(columnKey: string): columnKey is FrozenTaskColumnKey {
    return (FROZEN_TASK_COLUMN_KEYS as readonly string[]).includes(columnKey);
}

/**
 * Walks the frozen columns accumulating widths, so each one's `left` is the sum of everything frozen
 * to its left. Computed from the caller's `widthFor`, which is the SAME resolver the `<colgroup>`
 * applies — including a live drag override — so a resize re-derives the offsets in the very render
 * that applies the new width and the freeze never lags the column it follows.
 */
export function frozenTaskColumnOffsets(
    widthFor: (columnKey: string) => number,
): FrozenTaskColumnOffsets {
    const offsets: Record<FrozenTaskColumnKey, number> = { expand: 0, title: 0 };
    let left = 0;
    for (const key of FROZEN_TASK_COLUMN_KEYS) {
        offsets[key] = left;
        left += widthFor(key);
    }
    return offsets;
}

/**
 * The freeze line: a 1px inset line on the right edge of the LAST frozen column. It is a box-shadow,
 * not a border, because the table uses `border-collapse: collapse` — a collapsed border is painted
 * by the table's border grid and does not travel with a sticky cell, so it would be left behind at
 * the column's original position. A box-shadow is painted by the cell itself and therefore sticks.
 */
export const FROZEN_EDGE_CLASS = "shadow-[inset_-1px_0_0_0_hsl(var(--border))]";

/**
 * A frozen HEADER cell: opaque so the columns sliding underneath cannot bleed through, lifted to
 * z-20 so it covers the frozen BODY cells (z-10).
 *
 * Header layering is normal cells (z-auto) < frozen body cells (z-10) < frozen header cells (z-20).
 * In this left-only freeze the two frozen header cells ARE the intersection of the frozen column and
 * the header row — the top-left corner — so they hold the highest z-index inside the table. The
 * table wrapper is `isolate`, so these values are scoped to the table's own stacking context and
 * cannot escape above page chrome; and every value stays well below the module's overlays (Radix
 * Dialog/Popover/Select portal at `z-50`), so a menu or dialog always covers the freeze. There is no
 * separate tier above z-20 because the header row is not frozen VERTICALLY: the scroll container
 * only scrolls horizontally, so no header cell is sticky for the top edge.
 *
 * The background is `bg-muted/30` composited over the card the table sits on — the header row is
 * translucent, and a translucent sticky cell would let content slide visibly beneath it. The
 * composite is the exact colour the header already paints, not an approximation.
 */
export const FROZEN_HEADER_CELL_CLASS =
    "sticky z-20 bg-[color-mix(in_srgb,hsl(var(--muted))_30%,hsl(var(--card)))]";

/**
 * A frozen BODY cell: the opaque card surface, lifted to z-10 over the normal cells.
 *
 * The opaque background is what stops the scrolling columns from showing through the frozen block.
 * It would equally hide the row's own `hover:bg-muted/50`, so the hover tint is re-applied here via
 * `group-hover:` — the row carries `group` — as the same `muted/50` composited over the card. A
 * frozen row therefore still reads as hovered.
 */
export const FROZEN_BODY_CELL_CLASS =
    "sticky z-10 bg-card group-hover:bg-[color-mix(in_srgb,hsl(var(--muted))_50%,hsl(var(--card)))]";

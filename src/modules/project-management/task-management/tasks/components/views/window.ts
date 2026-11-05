/**
 * The row window, as arithmetic.
 *
 * The heights here are constants, never measurements: a table row is two lines when its parent
 * carries the subtask count or when a column-scored leaf names its answer (56px) and one line
 * otherwise (40px), and a card is a fixed 72px box. Nothing in the layout depends on the text
 * inside, so the offsets can be prefix sums and the window a binary search — no measurement pass,
 * no observers, and no drift as rows recycle.
 *
 * Deliberately free of React and of DOM types: only numbers in, numbers out, so the assertions in
 * `../../utils/__assert.ts` can prove it under `node --experimental-strip-types`.
 */

/** The rows to mount: `start` inclusive, `end` exclusive, both clamped into the list. */
export interface RowWindow {
    readonly start: number;
    readonly end: number;
}

/**
 * `offsets[i]` is the top of row `i`, and the last entry is the total height of the list — so the
 * spacer above the window and the one below it are both one lookup, and they always add up to the
 * real scroll height. An empty list is `[0]`: no rows, no height.
 */
export function buildOffsets(heights: readonly number[]): number[] {
    const offsets: number[] = [0];
    let total = 0;
    for (const height of heights) {
        total += height;
        offsets.push(total);
    }
    return offsets;
}

/**
 * The first row whose bottom edge is strictly below `y` — the row covering `y`, or `count` when
 * `y` is at or past the end of the list.
 */
function firstRowAfter(offsets: readonly number[], y: number): number {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
        const mid = (low + high) >> 1;
        const bottom = offsets[mid + 1] ?? Number.POSITIVE_INFINITY;
        if (bottom > y) high = mid;
        else low = mid + 1;
    }
    return low;
}

/**
 * The rows overlapping `[scrollTop, scrollTop + viewportHeight)`, widened by `overscan` rows on
 * each side so a fast flick mounts its rows before they land.
 *
 * The bounds are clamped, not wrapped: a scroll past the end keeps the last rows mounted, and
 * overscan never reaches below zero or past the list. A list with no rows is `0..0`. A viewport of
 * unknown height (the box is laid out after the commit, so it reads as 0 on the first pass) still
 * mounts one row rather than nothing.
 */
export function windowFor(
    offsets: readonly number[],
    scrollTop: number,
    viewportHeight: number,
    overscan: number,
): RowWindow {
    const count = Math.max(0, offsets.length - 1);
    if (count === 0) return { start: 0, end: 0 };

    const top = Math.max(0, scrollTop);
    const bottom = top + Math.max(0, viewportHeight);
    const span = Math.max(0, Math.trunc(overscan));

    const first = Math.min(firstRowAfter(offsets, top), count - 1);
    const last = Math.min(firstRowAfter(offsets, bottom), count);

    return {
        start: Math.max(0, first - span),
        end: Math.min(count, Math.max(last, first + 1) + span),
    };
}

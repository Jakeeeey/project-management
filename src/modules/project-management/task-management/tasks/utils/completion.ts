/**
 * The completion rollup behind the tasks page's Progress view.
 *
 * The department gives every status a `completion_percent` (0-100). A LEAF task's completion is
 * that number; a task with subtasks ignores its own status and carries the plain arithmetic mean of
 * its DIRECT children's completion values, recursively. Equal weight per child, so a branch with
 * twenty leaves does not outvote a sibling with one — which is why the mean is taken level by level
 * rather than over all descendants.
 *
 * Two bases feed the same rollup, so the arithmetic cannot differ between them:
 * - `statusCompletionScore` — a leaf scores its own status's percentage;
 * - `columnChoiceScore` — a leaf scores 100 when it carries one of the caller's "counts as done"
 *   answers in one Choice column, else 0.
 *
 * The parent mean is returned UNFLOORED, because the display has three bands a floored integer
 * cannot express: a mean strictly between 0 and 1 prints `<1%`, and flooring before formatting would
 * collapse that band into a misleading `0%`. {@link formatCompletionPercent} does the flooring, and it
 * deliberately floors rather than rounds, so 99.6 prints `99%` and never claims a false 100.
 *
 * Every helper is total: an orphan, a self-parent and a parent cycle all still produce a number, and
 * a cycle is broken at its back edge instead of recursing forever — `buildTree` promotes a cycle's
 * rows to roots for the same reason.
 *
 * This file imports nothing and uses only erasable syntax (no `enum`, no `namespace`, no parameter
 * properties) so `utils/__assert.ts` can load it through Node's native type stripping.
 */

/** One custom-column answer as the task rows already carry it. `value` is an option id for a Choice. */
export interface CompletionAnswer {
    readonly field_id: number;
    readonly value: string | null;
}

/** The minimum row shape the rollup reads; a full task row satisfies it structurally. */
export interface CompletionRow {
    readonly id: number;
    readonly parent_id: number | null;
    readonly status_id: number;
    readonly custom_values: readonly CompletionAnswer[];
}

/** A leaf's own score, 0-100. Called once per row, before any mean is taken. */
export type CompletionLeafScore<T extends CompletionRow> = (row: T) => number;

/** The three numbers the Progress view needs per row, keyed by task id. */
export interface CompletionRollup {
    /**
     * The row's DISPLAY value: its own score when it has no children, else the unfloored mean of its
     * direct children. Never floored here — see {@link formatCompletionPercent}.
     */
    readonly valueById: ReadonlyMap<number, number>;
    /** The row's own basis score, ignoring its subtasks. The disagreement flags compare against it. */
    readonly ownById: ReadonlyMap<number, number>;
    /** Direct children the mean covers; 0 for a leaf. Also the "N subtasks" caption's number. */
    readonly childCountById: ReadonlyMap<number, number>;
}

/** A stored percentage clamped to a whole 0-100; anything unusable reads as 0, never `NaN`. */
function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, Math.round(value)));
}

/** One frame of the explicit post-order walk, so a deep tree cannot overflow the call stack. */
interface RollupFrame {
    readonly id: number;
    index: number;
    sum: number;
    seen: number;
}

/**
 * Rolls completion up the adjacency list.
 *
 * @param rows      The department's live rows, flat.
 * @param leafScore The row's own score, 0-100. Only ever used for a row with no children — a parent's
 *                  own status is deliberately ignored for its number.
 * @returns Per-row display value, own score and child count.
 */
export function computeCompletion<T extends CompletionRow>(
    rows: readonly T[],
    leafScore: CompletionLeafScore<T>,
): CompletionRollup {
    const byId = new Map<number, T>();
    for (const row of rows) byId.set(row.id, row);

    const ownById = new Map<number, number>();
    for (const row of byId.values()) ownById.set(row.id, clampPercent(leafScore(row)));

    /*
     * Child lists mirror `buildTree`: an orphan (its parent is not in the set) and a self-parent are
     * roots, so neither is anybody's child. Every other row hangs from exactly one parent.
     */
    const childIds = new Map<number, number[]>();
    const rootIds: number[] = [];
    for (const row of byId.values()) {
        const parentId = row.parent_id;
        if (parentId === null || parentId === row.id || !byId.has(parentId)) {
            rootIds.push(row.id);
            continue;
        }
        const siblings = childIds.get(parentId);
        if (siblings === undefined) childIds.set(parentId, [row.id]);
        else siblings.push(row.id);
    }

    const valueById = new Map<number, number>();
    const childCountById = new Map<number, number>();
    /** Rows whose frame is on the stack — the cycle detector. */
    const open = new Set<number>();
    const stack: RollupFrame[] = [];
    const noChildren: readonly number[] = [];

    const walkFrom = (rootId: number): void => {
        stack.push({ id: rootId, index: 0, sum: 0, seen: 0 });
        open.add(rootId);

        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const children = childIds.get(frame.id) ?? noChildren;

            if (frame.index < children.length) {
                const childId = children[frame.index];
                frame.index += 1;

                if (open.has(childId)) {
                    /*
                     * A parent cycle: the back edge is left OUT of the mean, so this rollup agrees
                     * with the rendered tree, which detaches the same edge (`buildTree` promotes the
                     * cut row to a root). Counting the edge here would report a child that renders
                     * nowhere under this row. Terminating is still the point — a malformed chain
                     * must not recurse forever.
                     */
                    continue;
                }

                const resolved = valueById.get(childId);
                if (resolved !== undefined) {
                    frame.sum += resolved;
                    frame.seen += 1;
                    continue;
                }

                stack.push({ id: childId, index: 0, sum: 0, seen: 0 });
                open.add(childId);
                continue;
            }

            const own = ownById.get(frame.id) ?? 0;
            const resolvedValue = frame.seen === 0 ? own : frame.sum / frame.seen;
            valueById.set(frame.id, resolvedValue);
            childCountById.set(frame.id, frame.seen);
            open.delete(frame.id);
            stack.pop();

            // A finished child is handed to the parent frame that spawned it, which is why the walk
            // is post-order: no parent's mean is taken before every child has a value.
            const parent = stack[stack.length - 1];
            if (parent !== undefined) {
                parent.sum += resolvedValue;
                parent.seen += 1;
            }
        }
    };

    for (const rootId of rootIds) {
        if (valueById.has(rootId)) continue;
        walkFrom(rootId);
    }

    // A row trapped in a parent cycle hangs from no root. Promote it, exactly as `buildTree` does.
    for (const row of byId.values()) {
        if (valueById.has(row.id)) continue;
        walkFrom(row.id);
    }

    return { valueById, ownById, childCountById };
}

/** A leaf's score from its status: that status's stored percentage, 0 when the status is unknown. */
export function statusCompletionScore(
    percentByStatusId: ReadonlyMap<number, number>,
): CompletionLeafScore<CompletionRow> {
    return (row) => percentByStatusId.get(row.status_id) ?? 0;
}

/** A leaf's score from one Choice column: 100 when it carries a chosen answer, otherwise 0. */
export function columnChoiceScore<T extends CompletionRow>(
    fieldId: number,
    doneValues: ReadonlySet<string>,
): CompletionLeafScore<T> {
    return (row) => {
        for (const answer of row.custom_values) {
            if (answer.field_id !== fieldId) continue;
            return answer.value !== null && doneValues.has(answer.value) ? 100 : 0;
        }
        return 0;
    };
}

/**
 * The printed percentage: floors (99.6 -> `99%`, never a false `100%`), keeps the under-one band
 * distinct from zero (`<1%`), and prints exactly `100%` only at 100.
 */
export function formatCompletionPercent(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0%";
    const floored = Math.floor(value);
    return floored < 1 ? "<1%" : `${floored}%`;
}

/** The percentage spoken by a screen reader: `62 percent`, `less than 1 percent`, `0 percent`. */
export function describeCompletionPercent(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0 percent";
    const floored = Math.floor(value);
    return floored < 1 ? "less than 1 percent" : `${floored} percent`;
}

/**
 * The two disagreements the Note column flags. A row's own score and its rollup can only disagree
 * when it has subtasks, so a leaf never carries a flag.
 */
export type CompletionFlag =
    /** Own basis is complete (100) while the rollup is below 100. */
    | "complete-with-unfinished-subtasks"
    /** The rollup is a full 100 while the row's own basis is not complete. */
    | "subtasks-complete-not-marked";

/** The flag one row carries, or `null`. */
export function completionFlag(
    own: number,
    value: number,
    childCount: number,
): CompletionFlag | null {
    if (childCount === 0) return null;
    // A mean of 100 needs every child at 100, so `value >= 100` here means "all subtasks complete".
    if (own >= 100 && value < 100) return "complete-with-unfinished-subtasks";
    if (value >= 100 && own < 100) return "subtasks-complete-not-marked";
    return null;
}

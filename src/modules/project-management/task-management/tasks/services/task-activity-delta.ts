/**
 * The pure delta core of the task activity trail.
 *
 * `pm_task_activity` is APPEND-ONLY, and every row is a SNAPSHOT: `old_value`/`new_value` hold the
 * raw stored value while `old_label`/`new_label` hold the display text **at the time of the change**.
 * Renaming a custom column, a choice or the acting user therefore never rewrites history — which is
 * exactly why this file never resolves a label and why the writers below must hand it both sides.
 *
 * This module decides the one thing every write path shares: given change descriptors, which of them
 * are real changes, and what a stored row looks like. It imports nothing and uses only erasable
 * syntax (no `enum`, no `namespace`, no parameter properties) so `./__assert.ts` can load it through
 * Node's native type stripping without a database — the same arrangement `./task-field-value.ts`,
 * `./task-move-rules.ts` and `../../configure/services/task-config-policy.ts` have with that harness.
 */

/** The two actions `pm_task_activity.action` carries. There is deliberately no `deleted`. */
export type TaskActivityAction = "created" | "updated";

/**
 * The snapshot `field_label` of every BUILT-IN `field_key`. A custom column does not appear here:
 * its label is the column's own `label`, read at write time.
 */
export const TASK_ACTIVITY_FIELD_LABELS = {
    title: "Title",
    description: "Description",
    status_id: "Status",
    priority_id: "Priority",
    start_date: "Start date",
    end_date: "End date",
    parent_id: "Parent task",
    sort_order: "Order",
    assignee: "Assignee",
} as const;

/** Every built-in field key the trail knows a label for. */
export type TaskActivityBuiltInFieldKey = keyof typeof TASK_ACTIVITY_FIELD_LABELS;

/** The one `field_key` that names a custom column: it carries the `pm_task_field.id` in `field_id`. */
export const TASK_ACTIVITY_CUSTOM_FIELD_KEY = "custom";

/**
 * One field's before/after, already resolved to the raw stored text AND the display text.
 *
 * `field_id` is non-null only for `field_key = 'custom'`. A `null` label means "there is no display
 * text for this value" — a structural number, or a reference that could not be named at write time —
 * and is never filled in later, because a read-time join would let a rename rewrite history.
 */
export interface TaskActivityChange {
    readonly field_key: string;
    readonly field_id: number | null;
    readonly field_label: string;
    readonly old_value: string | null;
    readonly new_value: string | null;
    readonly old_label: string | null;
    readonly new_label: string | null;
}

/** A change with its action stamped on it — one insertable row, minus identity, actor and time. */
export interface TaskActivityDelta extends TaskActivityChange {
    readonly action: TaskActivityAction;
}

/** Everything a caller must supply to describe one field change. */
export interface TaskActivityChangeInput {
    readonly field_key: string;
    readonly field_label: string;
    readonly field_id?: number | null;
    readonly old_value?: unknown;
    readonly new_value?: unknown;
    readonly old_label?: string | null;
    readonly new_label?: string | null;
}

/**
 * A raw value as the trail's TEXT columns carry it.
 *
 * `null` and `undefined` both mean "no value" — an absent answer and a cleared one are the same
 * absence, which is what the value writer's soft-delete branch encodes. A number (a catalog id, a
 * sort order) becomes its decimal text; anything else object-shaped has no meaningful text form and
 * resolves to `null` rather than leaking `[object Object]` into the history.
 */
export function formatActivityValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
        return String(value);
    }
    return null;
}

/** Builds one change descriptor, normalising every raw value onto the stored TEXT shape. */
export function buildActivityChange(input: TaskActivityChangeInput): TaskActivityChange {
    return {
        field_key: input.field_key,
        field_id: input.field_id ?? null,
        field_label: input.field_label,
        old_value: formatActivityValue(input.old_value),
        new_value: formatActivityValue(input.new_value),
        old_label: input.old_label ?? null,
        new_label: input.new_label ?? null,
    };
}

/**
 * True only when something actually changed — the raw value OR the display text.
 *
 * The label is compared alongside the value because a reference can be re-pointed at a different row
 * that happens to carry the same id shape, and because a rename the writer chose to snapshot must not
 * be silently dropped. An unchanged pair is the writer's "no-op" signal.
 */
export function hasActivityChanged(change: TaskActivityChange): boolean {
    return (
        (change.old_value ?? null) !== (change.new_value ?? null) ||
        (change.old_label ?? null) !== (change.new_label ?? null)
    );
}

/**
 * The delta computation: drops nil entries, drops no-ops from an `updated` batch, and stamps the
 * action on every row that survives.
 *
 * A `created` batch keeps everything it is handed, because a create has no pre-state to compare
 * against and its `null` old side IS the record of that. The drop rule lives here — not in each
 * writer — so no write path can log a row for a value that never changed.
 */
export function buildTaskActivityDeltas(
    action: TaskActivityAction,
    changes: readonly (TaskActivityChange | null | undefined)[],
): TaskActivityDelta[] {
    const deltas: TaskActivityDelta[] = [];
    for (const change of changes) {
        if (change === null || change === undefined) continue;
        if (action === "updated" && !hasActivityChanged(change)) continue;
        deltas.push({ action, ...change });
    }
    return deltas;
}

/** The three name columns a display label is joined from. `unknown` so a shape change cannot lie. */
export interface UserNameParts {
    readonly user_fname?: unknown;
    readonly user_mname?: unknown;
    readonly user_lname?: unknown;
}

/**
 * The label of the catalog row an id names, from an already-loaded catalog list.
 *
 * An id that no longer resolves — a task still pointing at a since-soft-deleted row — has no display
 * text, so it yields `null` rather than the raw number dressed up as a label.
 */
export function catalogLabelOf(
    rows: readonly { readonly id: number; readonly label: string }[],
    id: unknown,
): string | null {
    const catalogId = Number(id);
    if (id === null || id === undefined || !Number.isFinite(catalogId)) return null;
    return rows.find((row) => row.id === catalogId)?.label ?? null;
}

/**
 * Joins `user_fname` / `user_mname` / `user_lname` into the display text an activity row snapshots.
 *
 * Blank pieces are dropped rather than collapsed into double spaces, and a wholly nameless row
 * resolves to `null` — the column is nullable, and "no name" must stay distinguishable from "".
 */
export function joinUserDisplayName(parts: UserNameParts): string | null {
    const pieces: string[] = [];
    for (const piece of [parts.user_fname, parts.user_mname, parts.user_lname]) {
        if (typeof piece !== "string") continue;
        const trimmed = piece.trim();
        if (trimmed !== "") pieces.push(trimmed);
    }
    return pieces.length === 0 ? null : pieces.join(" ");
}

import { DirectusRequestError, createItem, readItems } from "./directus-client";
import type { ScopedActor } from "./actor-service";
import { phNow } from "../utils/ph-time";
import { toNumberOrNull, toPhTimestamp } from "./task-payload";
import {
    buildTaskActivityDeltas,
    joinUserDisplayName,
    type TaskActivityAction,
    type TaskActivityChange,
} from "./task-activity-delta";

/**
 * The task activity trail — who changed which task field, from what value to what value.
 *
 * `pm_task_activity` is APPEND-ONLY: this module only ever INSERTs. There is deliberately no
 * `is_deleted`, no `updated_at` and no `updated_by` — a history row is a fact that happened, and
 * correcting one would mean rewriting it. A hard `pm_task` delete cascades its rows away (consistent
 * with `pm_task_field_value`); the app soft-deletes tasks, so the trail survives every action a user
 * can actually take.
 *
 * Three rules shape every method:
 *
 * 1. **Best-effort.** Directus has no multi-statement transaction, so a task write and its audit rows
 *    can never be one atomic unit. The audit therefore happens AFTER the task write succeeds and the
 *    recorder NEVER throws: a failure is logged server-side and swallowed, because a task edit must
 *    not fail just because the trail could not be written. An unavailable collection is the same
 *    story on the read side — an empty history, never an exception.
 * 2. **Snapshots, not joins.** `old_value`/`new_value` hold the raw stored value and
 *    `old_label`/`new_label` the display text AT WRITE TIME, resolved here (via `resolveUserLabel`)
 *    or by the caller (catalog and choice labels). A later rename therefore never rewrites history,
 *    and no reader may re-resolve a label.
 * 3. **One batch per logical save.** `batch_id` is a `crypto.randomUUID()` the caller generates once
 *    and threads through every row of one user action, so rows that arrived from separate writes
 *    (a scalar PATCH plus the custom answers of the same request, a create plus its defaults) still
 *    read back as one change.
 *
 * The delta itself is pure and lives in `./task-activity-delta`; this file owns only the I/O — the
 * actor's name, the row insert, and the department-scoped reads.
 */

/**
 * The one collection this service owns. It carries no `is_deleted` on purpose: the trail is
 * append-only, so nothing here ever filters a soft-delete (there is none) and nothing ever writes
 * one (there is no update path at all).
 */
const ACTIVITY_COLLECTION = "pm_task_activity";

/** Newest-first is `changed_at DESC, id DESC` — the id breaks a tie between rows of one batch. */
const NEWEST_FIRST: readonly string[] = ["-changed_at", "-id"];

/** The whole-department reader's default and hard cap, so a future audit view cannot pull the table. */
const DEFAULT_DEPARTMENT_LIMIT = 100;
const MAX_DEPARTMENT_LIMIT = 500;

/**
 * The per-task reader's default page and hard cap. The default is one side column's worth of events;
 * the cap is the most a caller may ever ask for, so no request can pull a whole task's trail.
 */
const DEFAULT_TASK_ACTIVITY_LIMIT = 20;
const MAX_TASK_ACTIVITY_LIMIT = 100;

/**
 * A `pm_task_activity` row as Directus returns it. Every column is `unknown`: a BIGINT can arrive as
 * a string, a DATETIME arrives with a `T` separator, and a missing collection answers 403 before any
 * shape is seen at all.
 */
interface RawActivityRow {
    readonly id?: unknown;
    readonly task_id?: unknown;
    readonly department_id?: unknown;
    readonly batch_id?: unknown;
    readonly action?: unknown;
    readonly field_key?: unknown;
    readonly field_id?: unknown;
    readonly field_label?: unknown;
    readonly old_value?: unknown;
    readonly new_value?: unknown;
    readonly old_label?: unknown;
    readonly new_label?: unknown;
    readonly actor_id?: unknown;
    readonly actor_label?: unknown;
    readonly changed_at?: unknown;
}

/** A `user` row reduced to the three name columns a display label is joined from. */
interface UserNameRow {
    readonly user_id: number;
    readonly user_fname?: unknown;
    readonly user_mname?: unknown;
    readonly user_lname?: unknown;
}

/** One history row as the module's wire shape: ids as numbers, the flag-free audit fields verbatim. */
export interface TaskActivityEntry {
    readonly id: number;
    readonly task_id: number;
    readonly department_id: number;
    /** Rows inserted by one logical save share this value; `null` only for a pre-batch legacy row. */
    readonly batch_id: string | null;
    readonly action: string;
    readonly field_key: string;
    /** The `pm_task_field.id` when `field_key = 'custom'`, else `null`. */
    readonly field_id: number | null;
    readonly field_label: string;
    readonly old_value: string | null;
    readonly new_value: string | null;
    readonly old_label: string | null;
    readonly new_label: string | null;
    readonly actor_id: number | null;
    readonly actor_label: string | null;
    readonly changed_at: string | null;
}

/** Paging knobs for the activity readers. Both are optional; the limit is bounded here. */
export interface TaskActivityQuery {
    readonly limit?: number;
    readonly page?: number;
    /** Row offset for the per-task reader; unused by the page-based department reader. */
    readonly offset?: number;
}

/** One page of one task's history, with the applied knobs echoed so a caller can see the cap. */
export interface TaskActivityPage {
    readonly entries: readonly TaskActivityEntry[];
    /** True when at least one older row was left behind; derived without a second read. */
    readonly hasMore: boolean;
    readonly limit: number;
    readonly offset: number;
}

/** A stored TEXT that reads as `null` when absent — never `undefined`, never `[object Object]`. */
function toTextOrNull(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

/**
 * Normalises the department reader's limit. A missing, non-finite or non-positive limit resolves to
 * the default rather than Directus's `-1` (the whole table), and a huge one is capped.
 */
function normaliseLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_DEPARTMENT_LIMIT;
    return Math.min(Math.floor(limit), MAX_DEPARTMENT_LIMIT);
}

/** The per-task reader's page size: a missing, non-finite or non-positive value defaults; a huge one caps. */
function normaliseTaskActivityLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_TASK_ACTIVITY_LIMIT;
    return Math.min(Math.floor(limit), MAX_TASK_ACTIVITY_LIMIT);
}

/** The per-task reader's offset: anything not a positive finite number reads as the first page. */
function normaliseTaskActivityOffset(offset: number | undefined): number {
    if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
    return Math.floor(offset);
}

/** Projects a raw row onto the wire shape; `changed_at` loses Directus's `T` separator. */
function toEntry(row: RawActivityRow): TaskActivityEntry {
    return {
        id: toNumberOrNull(row.id) ?? 0,
        task_id: toNumberOrNull(row.task_id) ?? 0,
        department_id: toNumberOrNull(row.department_id) ?? 0,
        batch_id: toTextOrNull(row.batch_id),
        action: toTextOrNull(row.action) ?? "updated",
        field_key: toTextOrNull(row.field_key) ?? "",
        field_id: toNumberOrNull(row.field_id),
        field_label: toTextOrNull(row.field_label) ?? "",
        old_value: toTextOrNull(row.old_value),
        new_value: toTextOrNull(row.new_value),
        old_label: toTextOrNull(row.old_label),
        new_label: toTextOrNull(row.new_label),
        actor_id: toNumberOrNull(row.actor_id),
        actor_label: toTextOrNull(row.actor_label),
        changed_at: toPhTimestamp(row.changed_at),
    };
}

/**
 * Reads one page whose final event is never split across a page boundary.
 *
 * A page is built from a `limit + 1`-row window: the extra row is a sentinel whose presence means
 * `hasMore`, so no second COUNT query is issued. Rows sharing a `batch_id` are one logical save and
 * must read back as ONE event, so if the last row kept and the next unread row share a `batch_id`,
 * the read keeps pulling rows until that batch ends. That means:
 *
 * - **A page may return MORE than the requested `limit` when its final batch is large.** That is
 *   correct and intended: a complete batch beats an exact row count, and an exact count is never
 *   allowed to render one save as several events.
 * - `hasMore` reports whether a row remains AFTER the completed final batch, so the walk neither
 *   loops nor drops rows.
 * - The returned row count is the number of rows consumed from `offset`, so walking
 *   `offset += <rows returned>` visits every row exactly once.
 *
 * Only a `null` `batch_id` (a legacy single-row event) is exempt from extension.
 */
async function readWholeBatchPage(
    readChunk: (offset: number, limit: number) => Promise<RawActivityRow[]>,
    offset: number,
    limit: number,
): Promise<{ rows: RawActivityRow[]; hasMore: boolean }> {
    const window = await readChunk(offset, limit + 1);
    const rows = window.slice(0, limit);
    let pending = window.slice(limit);
    const hasMore = pending.length > 0;

    const trailingBatch = rows.length === 0 ? null : toTextOrNull(rows[rows.length - 1]?.batch_id);
    if (!hasMore || trailingBatch === null) return { rows, hasMore };

    let nextOffset = offset + limit;
    for (;;) {
        if (pending.length === 0) {
            pending = await readChunk(nextOffset, MAX_TASK_ACTIVITY_LIMIT + 1);
            if (pending.length === 0) return { rows, hasMore: false };
        }

        const next = pending[0];
        if (toTextOrNull(next?.batch_id) !== trailingBatch) return { rows, hasMore: true };

        if (next !== undefined) rows.push(next);
        pending = pending.slice(1);
        nextOffset += 1;
    }
}

export class TaskActivityService {
    /**
     * A fresh `batch_id` for one logical save.
     *
     * The caller generates it once and passes it to every `record` call the save makes, so the rows
     * of one user action — a scalar PATCH plus its custom answers, a create plus the defaults that
     * landed on it — group together even though they were written by separate statements.
     */
    static newBatchId(): string {
        return crypto.randomUUID();
    }

    /**
     * The display label of one user, resolved from the `user` table at WRITE time — or `null` when
     * the row is missing or the read fails.
     *
     * Never throws: a task mutation must not fail because a label could not be looked up. A `null`
     * label is honest (the id is still recorded in `actor_id`/`old_value`), and it is deliberately
     * NOT back-filled by a reader, because a later rename must not rewrite a historical row.
     */
    static async resolveUserLabel(userId: number): Promise<string | null> {
        try {
            const rows = await readItems<UserNameRow>("user", {
                filter: { user_id: { _eq: userId } },
                fields: ["user_id", "user_fname", "user_mname", "user_lname"],
                limit: 1,
            });
            const row = rows[0];
            return row === undefined ? null : joinUserDisplayName(row);
        } catch (error: unknown) {
            console.error(
                `[task-activity] the display name of user ${userId} could not be resolved; ` +
                    "the activity row records the id without a label:",
                error,
            );
            return null;
        }
    }

    /**
     * Records one logical change set against one task — the ONLY write this module performs.
     *
     * `changes` is the caller's already-resolved description of what moved; the pure
     * `buildTaskActivityDeltas` drops the no-ops and stamps the action, so a caller may hand over a
     * candidate per field it considered without pre-filtering. `batchId` groups the rows with the
     * rest of the same save; omitted, one is generated.
     *
     * BEST-EFFORT BY CONTRACT: this method never throws. A missing `pm_task_activity` collection, an
     * unreachable Directus, or a rejected insert is logged server-side and swallowed, because the
     * task write it describes has already succeeded and must not be undone by its own audit trail.
     * An empty delta set writes nothing at all — not even a round trip.
     */
    static async record(
        actor: ScopedActor,
        taskId: number,
        action: TaskActivityAction,
        changes: readonly (TaskActivityChange | null | undefined)[],
        batchId?: string,
    ): Promise<void> {
        try {
            const deltas = buildTaskActivityDeltas(action, changes);
            if (deltas.length === 0) return;

            const batch = batchId ?? TaskActivityService.newBatchId();
            const actorLabel = await TaskActivityService.resolveUserLabel(actor.userId);
            const changedAt = phNow();

            for (const delta of deltas) {
                await createItem<unknown>(ACTIVITY_COLLECTION, {
                    task_id: taskId,
                    department_id: actor.departmentId,
                    batch_id: batch,
                    action: delta.action,
                    field_key: delta.field_key,
                    field_id: delta.field_id,
                    field_label: delta.field_label,
                    old_value: delta.old_value,
                    new_value: delta.new_value,
                    old_label: delta.old_label,
                    new_label: delta.new_label,
                    actor_id: actor.userId,
                    actor_label: actorLabel,
                    changed_at: changedAt,
                });
            }
        } catch (error: unknown) {
            console.error(
                `[task-activity] recording a '${action}' change set for task ${taskId} failed; ` +
                    "the task write it describes stands and the history row is lost:",
                error,
            );
        }
    }

    /**
     * One PAGE of one task's history, newest-first (`changed_at DESC, id DESC`), department-scoped.
     *
     * The department filter is what makes this safe to expose on the item route: another
     * department's task id returns an empty history rather than its rows. An unavailable collection
     * reads as an empty history — a pre-DDL deployment must still serve a task — while any other
     * Directus failure still throws, so an outage is never silently rendered as "no history".
     *
     * The read is bounded: `limit` defaults to one column's worth of events and can never exceed the
     * cap, and `offset` walks older rows. The page is aligned to whole `batch_id` groups and may
     * exceed `limit` to keep a large final batch intact (see `readWholeBatchPage`); `hasMore` comes
     * from the `limit + 1` sentinel row rather than a second COUNT read.
     */
    static async listActivity(
        actor: ScopedActor,
        taskId: string | number,
        query: TaskActivityQuery = {},
    ): Promise<TaskActivityPage> {
        const limit = normaliseTaskActivityLimit(query.limit);
        const offset = normaliseTaskActivityOffset(query.offset);
        const id = toNumberOrNull(taskId);
        if (id === null || id <= 0) return { entries: [], hasMore: false, limit, offset };

        const readChunk = (chunkOffset: number, chunkLimit: number): Promise<RawActivityRow[]> =>
            TaskActivityService.readRowsOrEmpty(() =>
                readItems<RawActivityRow>(ACTIVITY_COLLECTION, {
                    filter: {
                        task_id: { _eq: id },
                        department_id: { _eq: actor.departmentId },
                    },
                    sort: NEWEST_FIRST,
                    limit: chunkLimit,
                    offset: chunkOffset,
                }),
            );

        const page = await readWholeBatchPage(readChunk, offset, limit);
        return { entries: page.rows.map(toEntry), hasMore: page.hasMore, limit, offset };
    }

    /**
     * The whole department's history, newest-first — the future audit view's read.
     *
     * Deliberately limited (default 100, capped at 500) and paged rather than unbounded: the table
     * only ever grows, so an unpaged read would eventually be the largest response in the module.
     * The department filter is the whole scope — there is no cross-department read.
     */
    static async listDepartmentActivity(
        actor: ScopedActor,
        query: TaskActivityQuery = {},
    ): Promise<TaskActivityEntry[]> {
        const rows = await TaskActivityService.readRowsOrEmpty(() =>
            readItems<RawActivityRow>(ACTIVITY_COLLECTION, {
                filter: { department_id: { _eq: actor.departmentId } },
                sort: NEWEST_FIRST,
                limit: normaliseLimit(query.limit),
                ...(query.page === undefined ? {} : { page: query.page }),
            }),
        );
        return rows.map(toEntry);
    }

    /**
     * Runs a read that a deployment without the table cannot satisfy.
     *
     * Both readers share this: a 403/404 means the collection is not registered (Directus answers 403
     * for a missing single item and for an unregistered collection), which is a registration state
     * the owner clears with the DDL — not a defect and not something that should 500 a task read.
     * Only that state is swallowed; a genuine Directus failure still throws.
     */
    private static async readRowsOrEmpty(read: () => Promise<RawActivityRow[]>): Promise<RawActivityRow[]> {
        try {
            return await read();
        } catch (error: unknown) {
            if (error instanceof DirectusRequestError && (error.status === 403 || error.status === 404)) {
                console.error(
                    `[task-activity] ${ACTIVITY_COLLECTION} is unavailable (status ${error.status}); ` +
                        "reporting an empty history. Run the audit-trail DDL and register the collection in Directus.",
                );
                return [];
            }
            throw error;
        }
    }
}

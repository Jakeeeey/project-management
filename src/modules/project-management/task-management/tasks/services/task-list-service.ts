import { createItem, readItems, updateItem } from "./directus-client";
import { loadListScoped, type ScopedListRow } from "./scoping";
import type { ScopedActor } from "./actor-service";
import { phNow } from "../utils/ph-time";
import type { CreateTaskListInput, UpdateTaskListInput } from "../types/task-list.schema";
import {
    TaskListError,
    deleteListRefusal,
    duplicateNameRow,
    effectiveDefaultList,
    isTrueFlag,
    sortListRows,
} from "./task-list-policy";

export { TaskListError, deleteListRefusal, duplicateNameRow, effectiveDefaultList, sortListRows } from "./task-list-policy";
export type { ListDeleteRefusal, ListRow, TaskListErrorCode } from "./task-list-policy";

/**
 * The one fixed value this feature writes into `pm_task_list`: the default list every department is
 * guaranteed by `ensureDefaultList`. It is not a lookup table — the department owns the row and may
 * rename it — the name only identifies the row at creation time.
 */
const DEFAULT_LIST_NAME = "General";

/** What an implicit default-list ensure did: created one fixed row, or found a live list already there. */
export interface EnsureDefaultListResult {
    /** `true` only when THIS call inserted the row; a no-op reports `false`. */
    readonly created: boolean;
    /** The department's default list after the call — the row just created, or the live one already present. */
    readonly list: ScopedListRow;
}

/**
 * The in-flight ensure per department. `pm_task_list` carries no unique key, so the read-then-write
 * below is only idempotent under sequential calls; sharing one execution among concurrent callers
 * in this process is what makes the bootstrap route safe to hit twice at once.
 */
const pendingEnsures = new Map<number, Promise<EnsureDefaultListResult>>();

/**
 * The per-department task-list service.
 *
 * `pm_task_list` is the department's set of lists — the view dimension every task read and write is
 * scoped by. It follows the catalog service's discipline because it is the same kind of data: no
 * unique key, so a duplicate NAME among live rows is an explicit read-then-write 400; rows are only
 * ever soft-deleted, never hard-deleted; every write carries `department_id` and the audit columns
 * from the actor, never from a body; and `created_at`/`updated_at` come from `phNow()`.
 *
 * The default invariant mirrors the catalog's: a department always resolves to exactly one default
 * list. The owner's backfill flags the "General" row; `ensureLiveDefault` re-marks the effective
 * fallback on any write that could leave the department without one, and `deleteListRefusal`
 * refuses to remove either the last live list or the current default.
 *
 * The list CRUD route owns the head-only capability check (`assertCanManageLists`); this service
 * owns the data rules. `ensureDefaultList` is the module's ONE deliberately implicit write and is
 * ungated by design: it inserts a single fixed row and makes no decision (see its own doc). The
 * create path in `task-service` reads `listLists` here, so task creation and list CRUD always agree
 * about which lists are referenceable.
 */
export class TaskListService {
    /** The department's live lists, ordered by `(sort_order, id)` — the switcher's only source. */
    static async listLists(actor: ScopedActor): Promise<ScopedListRow[]> {
        return TaskListService.listLiveLists(actor);
    }

    /**
     * Ensures the department has its default list, creating the fixed "General" row iff the
     * department has NO live list at all. Idempotent in the catalog seed's sense: a department that
     * already owns any live list is left untouched and the call reports `created: false`, so a
     * second run never duplicates a row. Concurrent callers in this process share one execution
     * (`pendingEnsures`), so two simultaneous bootstraps insert once.
     *
     * This is the module's one deliberately implicit write: the row's name, order and default flag
     * are all fixed, so the actor decides nothing and no capability gate applies. Contrast
     * `TaskConfigService.seedDefaults`, which writes a whole fixture and so stays explicit and
     * head-gated.
     *
     * `actorId` is recorded as the audit author; `null` is an out-of-session bootstrap.
     */
    static ensureDefaultList(departmentId: number, actorId: number | null = null): Promise<EnsureDefaultListResult> {
        const pending = pendingEnsures.get(departmentId);
        if (pending !== undefined) return pending;

        const run = TaskListService.runEnsureDefaultList(departmentId, actorId).finally(() => {
            pendingEnsures.delete(departmentId);
        });
        pendingEnsures.set(departmentId, run);
        return run;
    }

    /**
     * Creates a list in the actor's department.
     *
     * Rejected with a 400 when a live list already carries the name — the table has no unique key,
     * so the check is read-then-write. The row is created unflagged and `ensureLiveDefault` then
     * marks it when the department has no default yet, so the first list of a fresh department
     * becomes its fallback rather than leaving task creation stranded.
     *
     * The created row is read back by its (now unique) name because Directus may answer a mutation
     * with 204 No Content; the read is how the generated id is learned.
     */
    static async create(actor: ScopedActor, input: CreateTaskListInput): Promise<ScopedListRow> {
        const live = await TaskListService.listLiveLists(actor);

        const duplicate = duplicateNameRow(live, input.name);
        if (duplicate !== null) {
            throw new TaskListError("VALIDATION_FAILED", `Another live task list already uses the name "${duplicate.name}"`);
        }

        const now = phNow();
        await createItem<unknown>("pm_task_list", {
            department_id: actor.departmentId,
            name: input.name,
            sort_order: input.sort_order ?? 0,
            is_default: 0,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });

        await TaskListService.ensureLiveDefault(actor);
        return TaskListService.readCreatedRow(actor, input.name);
    }

    /**
     * Renames and/or reorders one live list of the actor's department. The primary key never
     * changes, so a rename never touches a task row — tasks reference a list by foreign key.
     *
     * A name that collides with another live list is rejected with a 400. `is_default` cannot be
     * patched: the default flag is server-owned, which is why it is absent from the Zod schema.
     */
    static async update(actor: ScopedActor, id: string | number, input: UpdateTaskListInput): Promise<ScopedListRow> {
        const target = await TaskListService.requireLiveRow(actor, id);

        if (input.name !== undefined) {
            const duplicate = duplicateNameRow(await TaskListService.listLiveLists(actor), input.name, target.id);
            if (duplicate !== null) {
                throw new TaskListError("VALIDATION_FAILED", `Another live task list already uses the name "${duplicate.name}"`);
            }
        }

        const changes: { name?: string; sort_order?: number } = {};
        if (input.name !== undefined) changes.name = input.name;
        if (input.sort_order !== undefined) changes.sort_order = input.sort_order;

        const now = phNow();
        await updateItem<unknown>("pm_task_list", target.id, {
            ...changes,
            updated_at: now,
            updated_by: actor.userId,
        });

        return {
            ...target,
            name: changes.name ?? target.name,
            sort_order: changes.sort_order ?? target.sort_order,
            updated_at: now,
            updated_by: actor.userId,
        };
    }

    /**
     * Soft-deletes a list — never a hard delete. Refused when it is the department's last live list
     * or the list `effectiveDefaultList` resolves to; a non-live id is a 404. A missing default is
     * re-marked afterwards, so the fallback can never go absent.
     *
     * Deleting a list deliberately does not touch the tasks that reference it: their rows keep
     * their `list_id`, exactly as removing a custom column keeps its stored answers.
     */
    static async softDelete(actor: ScopedActor, id: string | number): Promise<ScopedListRow> {
        const target = await TaskListService.requireLiveRow(actor, id);
        const live = await TaskListService.listLiveLists(actor);

        const refusal = deleteListRefusal(live, target.id);
        if (refusal !== null) {
            switch (refusal) {
                case "not-found":
                    throw new TaskListError("NOT_FOUND", "No live task list with that id exists in the actor's department");
                case "last-live-row":
                    throw new TaskListError("VALIDATION_FAILED", "The last remaining task list of this department cannot be removed");
                case "current-default":
                    throw new TaskListError(
                        "VALIDATION_FAILED",
                        "The default task list cannot be removed; a department must always have exactly one default list",
                    );
            }
        }

        const now = phNow();
        await updateItem<unknown>("pm_task_list", target.id, {
            is_deleted: 1,
            updated_at: now,
            updated_by: actor.userId,
        });
        await TaskListService.ensureLiveDefault(actor);

        return { ...target, is_deleted: 1, updated_at: now, updated_by: actor.userId };
    }

    /**
     * The id a task references when it omits a list: the flagged default, else the lowest
     * `(sort_order, id)` live list. `null` means the department has no live list at all — the one
     * case that legitimately blocks task creation, and the case where a list read has nothing to
     * scope by.
     */
    static async resolveDefaultListId(actor: ScopedActor): Promise<number | null> {
        const live = await TaskListService.listLiveLists(actor);
        return effectiveDefaultList(live)?.id ?? null;
    }

    /** The department's live lists, sorted. Every list read funnels through here. */
    private static async listLiveLists(actor: ScopedActor): Promise<ScopedListRow[]> {
        return TaskListService.readLiveLists(actor.departmentId);
    }

    /** The department's live lists, sorted, from a bare department id (the ensure path has no actor). */
    private static async readLiveLists(departmentId: number): Promise<ScopedListRow[]> {
        const rows = await readItems<ScopedListRow>("pm_task_list", {
            filter: {
                department_id: { _eq: departmentId },
                is_deleted: { _eq: 0 },
            },
            limit: -1,
        });
        return sortListRows(rows);
    }

    /**
     * The body of `ensureDefaultList`, run once per department at a time. A live list already exists
     * → no write at all; otherwise one flagged "General" row is inserted and read back.
     */
    private static async runEnsureDefaultList(
        departmentId: number,
        actorId: number | null,
    ): Promise<EnsureDefaultListResult> {
        const live = await TaskListService.readLiveLists(departmentId);
        const current = effectiveDefaultList(live);
        if (current !== null) return { created: false, list: current };

        const now = phNow();
        await createItem<unknown>("pm_task_list", {
            department_id: departmentId,
            name: DEFAULT_LIST_NAME,
            sort_order: 0,
            is_default: 1,
            is_deleted: 0,
            created_at: now,
            created_by: actorId,
            updated_at: now,
            updated_by: actorId,
        });

        const created = await TaskListService.readLiveRowByName(departmentId, DEFAULT_LIST_NAME);
        if (created === null) {
            throw new TaskListError("INTERNAL_FAIL", "The default task list was created but could not be read back");
        }
        return { created: true, list: created };
    }

    /** Loads one live list of the actor's department, or throws the coded 404 the route maps. */
    private static async requireLiveRow(actor: ScopedActor, id: string | number): Promise<ScopedListRow> {
        const row = await loadListScoped(actor, id);
        if (row === null) {
            throw new TaskListError("NOT_FOUND", "No live task list with that id exists in the actor's department");
        }
        return row;
    }

    /**
     * The "a default can never be absent" invariant: when a department has live lists but none
     * flagged, the row `effectiveDefaultList` resolves to is marked. Reads still fall back even
     * before a write normalises the table, so a missing flag can never strand task creation.
     */
    private static async ensureLiveDefault(actor: ScopedActor): Promise<void> {
        const live = await TaskListService.listLiveLists(actor);
        const fallback = effectiveDefaultList(live);
        if (fallback === null || isTrueFlag(fallback.is_default)) return;

        await updateItem<unknown>("pm_task_list", fallback.id, {
            is_default: 1,
            updated_at: phNow(),
            updated_by: actor.userId,
        });
    }

    /** Reads a just-created row back by its name, which is unique among the department's live lists. */
    private static async readCreatedRow(actor: ScopedActor, name: string): Promise<ScopedListRow> {
        const row = await TaskListService.readLiveRowByName(actor.departmentId, name);
        if (row === null) {
            throw new TaskListError("INTERNAL_FAIL", "The task list was created but could not be read back");
        }
        return row;
    }

    /** The newest live row with this name, or `null` — the id-learner after a nameless create. */
    private static async readLiveRowByName(departmentId: number, name: string): Promise<ScopedListRow | null> {
        const rows = await readItems<ScopedListRow>("pm_task_list", {
            filter: {
                department_id: { _eq: departmentId },
                is_deleted: { _eq: 0 },
                name: { _eq: name },
            },
            sort: ["-id"],
            limit: 1,
        });
        return rows[0] ?? null;
    }
}

import { createItem, readItems, updateItem, updateItems } from "./directus-client";
import { loadConfigScoped, type ConfigKind, type ScopedConfigRow } from "./scoping";
import type { ScopedActor } from "./actor-service";
import { phNow } from "../utils/ph-time";
import type { CreateCatalogItemInput, UpdateCatalogItemInput } from "../types/task-config.schema";
import { seedDepartmentCatalogs, type SeedDefaultsResult } from "./catalog-seed";
import {
    CONFIG_COLLECTIONS,
    TaskConfigError,
    deleteRefusal,
    duplicateLabelRow,
    effectiveDefaultRow,
    isTrueFlag,
    sortCatalogRows,
} from "./task-config-policy";

export { TaskConfigError, deleteRefusal, duplicateLabelRow, effectiveDefaultRow, liveRows, sortCatalogRows } from "./task-config-policy";
export type { CatalogRow, DeleteRefusal, TaskConfigErrorCode } from "./task-config-policy";
export type { SeedDefaultsResult } from "./catalog-seed";

/**
 * The per-department status and priority catalog service.
 *
 * Two tables, one model per kind: `pm_task_status` and `pm_task_priority` have separate schemas but
 * identical columns and independent auto-increment id spaces, so every call names its
 * `kind: "status" | "priority"` — a bare id is ambiguous. Tasks reference a catalog row by primary
 * key (there is no `slug` and no unique key), so a rename or recolour is a single-row write that
 * every referencing task reflects immediately, with no task row touched.
 *
 * Scoping: every read and every write carries `department_id` from the actor — or, for
 * `seedDefaults`, the department id the route passed after resolving the actor. The route owns the
 * `assertCanConfigure` capability check; this service owns the data rules (duplicate labels, the
 * soft-delete guards, the default invariant) and audit injection.
 */

/** The two catalog lists of one department, as the configuration route returns them. */
export interface CatalogLists {
    statuses: ScopedConfigRow[];
    priorities: ScopedConfigRow[];
}

export class TaskConfigService {
    /**
     * The department's live catalog for one kind, ordered by `(sort_order, id)`.
     *
     * Live-only by construction: pickers, filters and the configuration list must never see a
     * soft-deleted row, so there is no soft-delete-inclusive catalog query in the module.
     */
    static async listByKind(actor: ScopedActor, kind: ConfigKind): Promise<ScopedConfigRow[]> {
        return TaskConfigService.listLiveRows(actor, kind);
    }

    /** Both catalog lists in one call — the shape the configuration route's GET returns. */
    static async listCatalog(actor: ScopedActor): Promise<CatalogLists> {
        const [statuses, priorities] = await Promise.all([
            TaskConfigService.listByKind(actor, "status"),
            TaskConfigService.listByKind(actor, "priority"),
        ]);
        return { statuses, priorities };
    }

    /**
     * Creates a catalog row in the actor's department.
     *
     * Rejected with a 400 when a live row of the same kind already carries the label — the catalogs
     * have no unique key, so the check is read-then-write. Creating a row flagged default clears the
     * previous default; creating the first row of a kind marks it as that kind's default, so a
     * default always exists.
     *
     * The created row is read back by its (now unique) label because Directus may answer a mutation
     * with 204 No Content; the read is how the generated id is learned.
     */
    static async create(actor: ScopedActor, kind: ConfigKind, input: CreateCatalogItemInput): Promise<ScopedConfigRow> {
        const live = await TaskConfigService.listLiveRows(actor, kind);

        const duplicate = duplicateLabelRow(live, input.label);
        if (duplicate !== null) {
            throw new TaskConfigError("VALIDATION_FAILED", `Another live ${kind} already uses the label "${duplicate.label}"`);
        }

        if (input.is_default === true) await TaskConfigService.clearFlaggedDefaults(actor, kind, live);

        const now = phNow();
        await createItem<unknown>(CONFIG_COLLECTIONS[kind], {
            department_id: actor.departmentId,
            label: input.label,
            color: input.color ?? null,
            sort_order: input.sort_order ?? 0,
            is_default: input.is_default === true ? 1 : 0,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });

        await TaskConfigService.ensureLiveDefault(actor, kind);
        return TaskConfigService.readCreatedRow(actor, kind, input.label);
    }

    /**
     * Updates one live catalog row of the actor's department. Every field is editable at any time;
     * the primary key never changes, so a rename never touches a task row.
     *
     * A label that collides with another live row of the same kind is rejected with a 400.
     * `is_default: true` moves the flag, clearing the previous default; `is_default: false` is a
     * no-op, because a kind must always resolve to a default.
     */
    static async update(
        actor: ScopedActor,
        kind: ConfigKind,
        id: string | number,
        input: UpdateCatalogItemInput,
    ): Promise<ScopedConfigRow> {
        const target = await TaskConfigService.requireLiveRow(actor, kind, id);
        const live = await TaskConfigService.listLiveRows(actor, kind);

        if (input.label !== undefined) {
            const duplicate = duplicateLabelRow(live, input.label, target.id);
            if (duplicate !== null) {
                throw new TaskConfigError("VALIDATION_FAILED", `Another live ${kind} already uses the label "${duplicate.label}"`);
            }
        }

        const changes: { label?: string; color?: string | null; sort_order?: number; is_default?: number } = {};
        if (input.label !== undefined) changes.label = input.label;
        if (input.color !== undefined) changes.color = input.color;
        if (input.sort_order !== undefined) changes.sort_order = input.sort_order;
        if (input.is_default === true) {
            await TaskConfigService.clearFlaggedDefaults(
                actor,
                kind,
                live.filter((row) => row.id !== target.id),
            );
            changes.is_default = 1;
        }

        const now = phNow();
        await updateItem<unknown>(CONFIG_COLLECTIONS[kind], target.id, {
            ...changes,
            updated_at: now,
            updated_by: actor.userId,
        });

        return {
            ...target,
            label: changes.label ?? target.label,
            color: changes.color !== undefined ? changes.color : target.color,
            sort_order: changes.sort_order ?? target.sort_order,
            is_default: changes.is_default ?? target.is_default,
            updated_at: now,
            updated_by: actor.userId,
        };
    }

    /**
     * Soft-deletes a catalog row — never a hard delete. Refused when the row is the last live row of
     * its kind or the row the kind currently defaults to; a non-live id is a 404. A missing default
     * is re-marked afterwards.
     */
    static async softDelete(actor: ScopedActor, kind: ConfigKind, id: string | number): Promise<ScopedConfigRow> {
        const target = await TaskConfigService.requireLiveRow(actor, kind, id);
        const live = await TaskConfigService.listLiveRows(actor, kind);

        const refusal = deleteRefusal(live, target.id);
        if (refusal !== null) {
            switch (refusal) {
                case "not-found":
                    throw new TaskConfigError("NOT_FOUND", `No live ${kind} with that id exists in the actor's department`);
                case "last-live-row":
                    throw new TaskConfigError("VALIDATION_FAILED", `The last remaining ${kind} of this department cannot be removed`);
                case "current-default":
                    throw new TaskConfigError(
                        "VALIDATION_FAILED",
                        `The current default ${kind} cannot be removed; make another row the default first`,
                    );
            }
        }

        const now = phNow();
        await updateItem<unknown>(CONFIG_COLLECTIONS[kind], target.id, {
            is_deleted: 1,
            updated_at: now,
            updated_by: actor.userId,
        });
        await TaskConfigService.ensureLiveDefault(actor, kind);

        return { ...target, is_deleted: 1, updated_at: now, updated_by: actor.userId };
    }

    /** Makes a row the kind's default, clearing whichever row carried the flag before. Idempotent. */
    static async setDefault(actor: ScopedActor, kind: ConfigKind, id: string | number): Promise<ScopedConfigRow> {
        const target = await TaskConfigService.requireLiveRow(actor, kind, id);
        if (isTrueFlag(target.is_default)) return target;

        const live = await TaskConfigService.listLiveRows(actor, kind);
        await TaskConfigService.clearFlaggedDefaults(
            actor,
            kind,
            live.filter((row) => row.id !== target.id),
        );

        const now = phNow();
        await updateItem<unknown>(CONFIG_COLLECTIONS[kind], target.id, {
            is_default: 1,
            updated_at: now,
            updated_by: actor.userId,
        });

        return { ...target, is_default: 1, updated_at: now, updated_by: actor.userId };
    }

    /**
     * The id a task references when it omits a status or priority: the flagged default, else the
     * lowest `(sort_order, id)` live row. `null` means the kind has no live rows at all — the one
     * case that legitimately blocks task creation.
     */
    static async resolveDefaultId(actor: ScopedActor, kind: ConfigKind): Promise<number | null> {
        const live = await TaskConfigService.listLiveRows(actor, kind);
        return effectiveDefaultRow(live)?.id ?? null;
    }

    /**
     * Seeds a department's initial catalogs from the seed fixture. Idempotent: a kind that already
     * has any live row is left untouched, so a second run never duplicates a row and reports zero.
     *
     * `actorId` is recorded as the audit author; `null` is the owner's out-of-session bootstrap.
     */
    static async seedDefaults(departmentId: number, actorId: number | null = null): Promise<SeedDefaultsResult> {
        return seedDepartmentCatalogs(departmentId, actorId);
    }

    /** The department's live rows of one kind, sorted. Every catalog read funnels through here. */
    private static async listLiveRows(actor: ScopedActor, kind: ConfigKind): Promise<ScopedConfigRow[]> {
        const rows = await readItems<ScopedConfigRow>(CONFIG_COLLECTIONS[kind], {
            filter: {
                department_id: { _eq: actor.departmentId },
                is_deleted: { _eq: 0 },
            },
            limit: -1,
        });
        return sortCatalogRows(rows);
    }

    /** Loads one live row of the actor's department, or throws the coded 404 the route maps. */
    private static async requireLiveRow(
        actor: ScopedActor,
        kind: ConfigKind,
        id: string | number,
    ): Promise<ScopedConfigRow> {
        const row = await loadConfigScoped(actor, kind, id);
        if (row === null) {
            throw new TaskConfigError("NOT_FOUND", `No live ${kind} with that id exists in the actor's department`);
        }
        return row;
    }

    /** Clears the default flag from every row of the given set that carries it, in one batched write. */
    private static async clearFlaggedDefaults(
        actor: ScopedActor,
        kind: ConfigKind,
        rows: readonly ScopedConfigRow[],
    ): Promise<void> {
        const flagged = rows.filter((row) => isTrueFlag(row.is_default));
        if (flagged.length === 0) return;

        const now = phNow();
        await updateItems<unknown>(
            CONFIG_COLLECTIONS[kind],
            flagged.map((row) => ({
                id: row.id,
                is_default: 0,
                updated_at: now,
                updated_by: actor.userId,
            })),
        );
    }

    /**
     * The "a default can never be absent" invariant: when a kind has live rows but none flagged, the
     * row `effectiveDefaultRow` resolves to is marked. Reads still fall back even before a write
     * normalises the table, so a missing flag can never strand task creation.
     */
    private static async ensureLiveDefault(actor: ScopedActor, kind: ConfigKind): Promise<void> {
        const live = await TaskConfigService.listLiveRows(actor, kind);
        const fallback = effectiveDefaultRow(live);
        if (fallback === null || isTrueFlag(fallback.is_default)) return;

        await updateItem<unknown>(CONFIG_COLLECTIONS[kind], fallback.id, {
            is_default: 1,
            updated_at: phNow(),
            updated_by: actor.userId,
        });
    }

    /** Reads a just-created row back by its label, which is unique among the kind's live rows. */
    private static async readCreatedRow(
        actor: ScopedActor,
        kind: ConfigKind,
        label: string,
    ): Promise<ScopedConfigRow> {
        const rows = await readItems<ScopedConfigRow>(CONFIG_COLLECTIONS[kind], {
            filter: {
                department_id: { _eq: actor.departmentId },
                is_deleted: { _eq: 0 },
                label: { _eq: label },
            },
            sort: ["-id"],
            limit: 1,
        });

        const row: ScopedConfigRow | undefined = rows[0];
        if (row === undefined) {
            throw new TaskConfigError("INTERNAL_FAIL", `The ${kind} row was created but could not be read back`);
        }
        return row;
    }
}

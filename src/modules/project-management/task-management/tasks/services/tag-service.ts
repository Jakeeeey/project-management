import { DirectusRequestError, createItem, readItems, updateItem } from "./directus-client";
import type { ScopedActor } from "./actor-service";
import type { ScopedTaskRow } from "./scoping";
import { phNow } from "../utils/ph-time";
import type { CreateTagInput, TagWireRow, TaskTagMutationInput, UpdateTagInput } from "../types/tag.schema";
import { toNumberOrNull } from "./task-payload";
import {
    duplicateTagRow,
    isTagDeleted,
    liveTagRows,
    sortTagRows,
    tagRefsByTask,
    tagReviveCandidate,
    type TagRow,
    type TaskTagRef,
} from "./tag-policy";

/**
 * The tag service — a department's tag catalog and the tags on one task.
 *
 * `pm_tag` is a catalog like `pm_task_status`, with two differences that shape this file:
 *
 * 1. A tag is optional, so nothing here is on the task-create path and the catalog is never
 *    "required" the way a status is.
 * 2. `pm_task_tag` is a join row keyed logically by `(task_id, tag_id)`. That key ignores
 *    `is_deleted`, so attaching a tag is REVIVE-OR-INSERT exactly like the assignee service: a hit
 *    (live or soft-deleted) is patched back to `is_deleted: 0`, and only a genuine miss inserts.
 *
 * Both tables may not exist yet while the owner's DDL is pending, so every READ path that feeds a
 * task payload degrades to "no tags" instead of throwing: `listDepartmentTagRefs` and
 * `listTaskTagRefs` swallow a Directus failure and log it, and `list` does the same for the
 * catalog. Writes are not degraded — attaching, detaching or editing a tag against a missing table
 * is a real failure, and a silent success would be a lie.
 *
 * Audit columns are injected server-side from the actor in Philippine time; a revive keeps the
 * original `created_at` / `created_by`, because the row is revived, not recreated.
 */

const TAG_COLLECTION = "pm_tag";
const TASK_TAG_COLLECTION = "pm_task_tag";

/** The coded failure kinds this service throws. The routes map them to 400 / 404 / 500. */
export type TagServiceErrorCode = "VALIDATION_FAILED" | "NOT_FOUND" | "INTERNAL_FAIL";

/** A tag refusal, carrying the `CODE: message` shape conventions section 13 pins. */
export class TagServiceError extends Error {
    readonly code: TagServiceErrorCode;

    constructor(code: TagServiceErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "TagServiceError";
        this.code = code;
    }
}

/** A `pm_tag` row as Directus returns it: every column optional-unknown, because ids and flags vary. */
interface RawTagRow {
    readonly id?: unknown;
    readonly label?: unknown;
    readonly color?: unknown;
    readonly sort_order?: unknown;
    readonly icon?: unknown;
    readonly is_deleted?: unknown;
}

/** One `pm_task_tag` row as Directus returns it. */
interface RawTaskTagRow {
    readonly id?: unknown;
    readonly task_id: unknown;
    readonly tag_id: unknown;
    readonly is_deleted: unknown;
}

/** A tag row with its numbers normalised, so the pure rules in `tag-policy` can read it. */
interface TagRecord extends TagRow {
    readonly color: string | null;
    readonly icon: string | null;
}

function toTagRecord(row: RawTagRow): TagRecord | null {
    const id = toNumberOrNull(row.id);
    if (id === null || id <= 0) return null;
    return {
        id,
        label: typeof row.label === "string" ? row.label : "",
        color: typeof row.color === "string" ? row.color : null,
        sort_order: toNumberOrNull(row.sort_order) ?? 0,
        icon: typeof row.icon === "string" ? row.icon : null,
        is_deleted: row.is_deleted,
    };
}

function toWireRow(record: TagRecord): TagWireRow {
    return {
        id: record.id,
        label: record.label,
        color: record.color,
        sort_order: record.sort_order,
        icon: record.icon,
    };
}

export class TagService {
    /** The department's live catalog, ordered by `(sort_order, id)`; empty while `pm_tag` is absent. */
    static async list(actor: ScopedActor): Promise<TagWireRow[]> {
        try {
            const rows = await TagService.readDepartmentTags(actor);
            return sortTagRows(liveTagRows(rows)).map(toWireRow);
        } catch (error) {
            if (!(error instanceof DirectusRequestError)) throw error;
            console.warn("[tags] pm_tag is not readable yet; the department is served without tags");
            return [];
        }
    }

    /**
     * Creates a tag, or REVIVES the soft-deleted row that already carries the label.
     *
     * The revive is not an optimisation: `(department_id, label)` is the logical key and ignores
     * `is_deleted`, so a blind INSERT after a delete would leave two rows claiming the same label.
     * A revive keeps the stored label — the requested spelling may differ only in case, and the row
     * is the same tag coming back — and takes the new colour and order.
     */
    static async create(actor: ScopedActor, input: CreateTagInput): Promise<TagWireRow> {
        const rows = await TagService.readDepartmentTags(actor, true);
        const candidate = tagReviveCandidate(rows, input.label);
        if (candidate !== null && !isTagDeleted(candidate.is_deleted)) {
            throw new TagServiceError(
                "VALIDATION_FAILED",
                `Another live tag already uses the label "${candidate.label}"`,
            );
        }

        const now = phNow();
        if (candidate !== null) {
            const revived: TagRecord = {
                ...candidate,
                color: input.color ?? null,
                sort_order: input.sort_order ?? 0,
                icon: input.icon ?? null,
                is_deleted: 0,
            };
            await updateItem<unknown>(TAG_COLLECTION, candidate.id, {
                is_deleted: 0,
                color: revived.color,
                sort_order: revived.sort_order,
                icon: revived.icon,
                updated_at: now,
                updated_by: actor.userId,
            });
            return toWireRow(revived);
        }

        await createItem<unknown>(TAG_COLLECTION, {
            department_id: actor.departmentId,
            label: input.label,
            color: input.color ?? null,
            sort_order: input.sort_order ?? 0,
            icon: input.icon ?? null,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });

        return toWireRow(await TagService.readCreatedTag(actor, input.label));
    }

    /** Renames, recolours or reorders one live tag; every field is optional and only changes are written. */
    static async update(actor: ScopedActor, id: number, input: UpdateTagInput): Promise<TagWireRow> {
        const rows = await TagService.readDepartmentTags(actor);
        const target = rows.find((row) => row.id === id) ?? null;
        if (target === null) throw TagService.notFound();

        if (input.label !== undefined) {
            const duplicate = duplicateTagRow(rows, input.label, target.id);
            if (duplicate !== null) {
                throw new TagServiceError(
                    "VALIDATION_FAILED",
                    `Another live tag already uses the label "${duplicate.label}"`,
                );
            }
        }

        const changes: { label?: string; color?: string | null; sort_order?: number; icon?: string | null } = {};
        if (input.label !== undefined) changes.label = input.label;
        if (input.color !== undefined) changes.color = input.color;
        if (input.sort_order !== undefined) changes.sort_order = input.sort_order;
        if (input.icon !== undefined) changes.icon = input.icon;

        await updateItem<unknown>(TAG_COLLECTION, target.id, {
            ...changes,
            updated_at: phNow(),
            updated_by: actor.userId,
        });

        return toWireRow({
            ...target,
            label: changes.label ?? target.label,
            color: changes.color !== undefined ? changes.color : target.color,
            sort_order: changes.sort_order ?? target.sort_order,
            icon: changes.icon !== undefined ? changes.icon : target.icon,
        });
    }

    /** Soft-deletes one tag — never a hard delete, so a later create with the same label revives it. */
    static async softDelete(actor: ScopedActor, id: number): Promise<TagWireRow> {
        const rows = await TagService.readDepartmentTags(actor);
        const target = rows.find((row) => row.id === id) ?? null;
        if (target === null) throw TagService.notFound();

        await updateItem<unknown>(TAG_COLLECTION, target.id, {
            is_deleted: 1,
            updated_at: phNow(),
            updated_by: actor.userId,
        });

        return toWireRow({ ...target, is_deleted: 1 });
    }

    /** Attaches a live tag of the actor's department to the task — REVIVE-OR-INSERT. */
    static async assign(actor: ScopedActor, task: ScopedTaskRow, input: TaskTagMutationInput): Promise<TaskTagRef> {
        await TagService.requireLiveTag(actor, input.tag_id);

        const existing = await TagService.readLinkCandidate(task.id, input.tag_id);
        const now = phNow();
        if (existing !== null) {
            await updateItem<unknown>(TASK_TAG_COLLECTION, existing.id, {
                is_deleted: 0,
                updated_at: now,
                updated_by: actor.userId,
            });
            return { tag_id: input.tag_id };
        }

        await createItem<unknown>(TASK_TAG_COLLECTION, {
            task_id: task.id,
            tag_id: input.tag_id,
            department_id: actor.departmentId,
            is_deleted: 0,
            created_at: now,
            created_by: actor.userId,
            updated_at: now,
            updated_by: actor.userId,
        });
        return { tag_id: input.tag_id };
    }

    /** Detaches one tag from the task by soft-deleting the live link; a missing live link is a 404. */
    static async unassign(actor: ScopedActor, task: ScopedTaskRow, input: TaskTagMutationInput): Promise<TaskTagRef> {
        const rows = await readItems<{ readonly id?: unknown }>(TASK_TAG_COLLECTION, {
            filter: {
                task_id: { _eq: task.id },
                tag_id: { _eq: input.tag_id },
                department_id: { _eq: actor.departmentId },
                is_deleted: { _eq: 0 },
            },
            fields: ["id"],
            limit: 1,
        });
        const linkId = rows.length === 0 ? null : toNumberOrNull(rows[0]?.id);
        if (linkId === null) {
            throw new TagServiceError("NOT_FOUND", "This tag is not on the task");
        }

        await updateItem<unknown>(TASK_TAG_COLLECTION, linkId, {
            is_deleted: 1,
            updated_at: phNow(),
            updated_by: actor.userId,
        });
        return { tag_id: input.tag_id };
    }

    /** One task's live tags; a missing `pm_task_tag` table answers `[]` instead of failing the read. */
    static async listTaskTagRefs(actor: ScopedActor, taskId: number): Promise<TaskTagRef[]> {
        try {
            const rows = await readItems<RawTaskTagRow>(TASK_TAG_COLLECTION, {
                filter: {
                    task_id: { _eq: taskId },
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: -1,
            });
            return tagRefsByTask(rows).get(taskId) ?? [];
        } catch (error) {
            if (!(error instanceof DirectusRequestError)) throw error;
            console.warn(`[tags] pm_task_tag is not readable yet; task ${taskId} is served without tags`);
            return [];
        }
    }

    /**
     * The whole department's live links, grouped by task — one query for a task list. Degrades to an
     * empty map on the same Directus failure `listTaskTagRefs` tolerates.
     */
    static async listDepartmentTagRefs(actor: ScopedActor): Promise<Map<number, TaskTagRef[]>> {
        try {
            const rows = await readItems<RawTaskTagRow>(TASK_TAG_COLLECTION, {
                filter: {
                    department_id: { _eq: actor.departmentId },
                    is_deleted: { _eq: 0 },
                },
                limit: -1,
            });
            return tagRefsByTask(rows);
        } catch (error) {
            if (!(error instanceof DirectusRequestError)) throw error;
            console.warn("[tags] pm_task_tag is not readable yet; the department's tasks are served without tags");
            return new Map();
        }
    }

    /** The department's rows, live only unless a revive/duplicate check needs the deleted ones too. */
    private static async readDepartmentTags(actor: ScopedActor, includeDeleted = false): Promise<TagRecord[]> {
        const filter: Record<string, unknown> = { department_id: { _eq: actor.departmentId } };
        if (!includeDeleted) filter.is_deleted = { _eq: 0 };

        const rows = await readItems<RawTagRow>(TAG_COLLECTION, { filter, limit: -1 });
        const records: TagRecord[] = [];
        for (const row of rows) {
            const record = toTagRecord(row);
            if (record !== null) records.push(record);
        }
        return records;
    }

    /** Reads a just-created row back by its label — the read is how the generated id is learned. */
    private static async readCreatedTag(actor: ScopedActor, label: string): Promise<TagRecord> {
        const rows = await readItems<RawTagRow>(TAG_COLLECTION, {
            filter: {
                department_id: { _eq: actor.departmentId },
                is_deleted: { _eq: 0 },
                label: { _eq: label },
            },
            sort: ["-id"],
            limit: 1,
        });
        const record = rows.length === 0 ? null : toTagRecord(rows[0] ?? {});
        if (record === null) {
            throw new TagServiceError("INTERNAL_FAIL", "The tag was created but could not be read back");
        }
        return record;
    }

    /** The tag the actor's department must own and still have live; a miss is the route's 404. */
    private static async requireLiveTag(actor: ScopedActor, tagId: number): Promise<TagRecord> {
        const rows = await TagService.readDepartmentTags(actor);
        const target = rows.find((row) => row.id === tagId) ?? null;
        if (target === null) throw TagService.notFound();
        return target;
    }

    /** The lowest-id existing link, INCLUDING a soft-deleted one — the revive target. */
    private static async readLinkCandidate(
        taskId: number,
        tagId: number,
    ): Promise<{ readonly id: number; readonly is_deleted: unknown } | null> {
        const rows = await readItems<{ readonly id?: unknown; readonly is_deleted?: unknown }>(TASK_TAG_COLLECTION, {
            filter: { task_id: { _eq: taskId }, tag_id: { _eq: tagId } },
            fields: ["id", "is_deleted"],
            limit: -1,
        });

        let lowest: { readonly id: number; readonly is_deleted: unknown } | null = null;
        for (const row of rows) {
            const id = toNumberOrNull(row.id);
            if (id === null) continue;
            if (lowest === null || id < lowest.id) lowest = { id, is_deleted: row.is_deleted };
        }
        return lowest;
    }

    private static notFound(): TagServiceError {
        return new TagServiceError("NOT_FOUND", "No live tag with that id exists in your department");
    }
}

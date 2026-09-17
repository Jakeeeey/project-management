import { updateItems } from "@/modules/project-management/services/directus-client";
import type { ScopedActor } from "@/modules/project-management/services/actor-service";
import type { PermissionContext } from "@/modules/project-management/services/permission-service";
import { loadTaskScoped, type ScopedTaskRow } from "@/modules/project-management/services/scoping";
import { isDescendant, type TreeSourceRow } from "@/modules/project-management/utils/tree";
import { phNow } from "@/modules/project-management/utils/ph-time";
import type { MoveTaskInput } from "../types/pm-task.schema";
import { containsExactlyOnce, isCompletePostMoveChildSet } from "./task-move-rules";
import { TaskItemService } from "./task-item-service";
import { TaskService, TaskServiceError } from "./task-service";
import { TASK_ACTIVITY_FIELD_LABELS, buildActivityChange } from "./task-activity-delta";
import { TaskActivityService } from "./task-activity-service";
import type { TaskClientRow } from "./task-payload";

/**
 * One move request as the service applies it: the moved node, the **resolved** destination parent
 * (`null` = root) and the complete ordered sibling list that becomes the stored `sort_order`
 * sequence. The parent id is passed in already validated by `TaskService.resolveParentId`.
 */
interface MoveTarget {
    readonly movedId: number;
    readonly parentId: number | null;
    readonly siblingIds: readonly number[];
}

/**
 * The move service — reorder and re-parent, in one write.
 *
 * The route has already loaded the moved node through `loadTaskScoped`, so the department guard ran
 * and a miss became a 404 before anything here executes. The target parent is validated with
 * `TaskService.resolveParentId` — the create path's exact rule (live row, actor's department, 400
 * otherwise) — because create and move must never disagree about which parent is referenceable.
 *
 * Two guards the route's contract adds on top of that:
 * - **Self-parenting is refused explicitly.** `utils/tree.isDescendant` is deliberately strict and
 *   answers `false` for `x` against `x`, so relying on the cycle walk alone would let a task become
 *   its own parent — the one cycle the walk cannot see.
 * - **The sibling list must be exactly the target parent's complete post-move child set.** The rule
 *   lives in `./task-move-rules` (pure and assertable), and its membership subtlety is the reason
 *   this contract is easy to get wrong: before the write the moved node is still under its old
 *   parent (or is a root), so the moved id is treated as a member of the target's children.
 *
 * The write is ONE bulk `PATCH pm_task` whose array body carries the moved node's `parent_id` plus
 * `sort_order = index` and the audit columns for **every** sibling in the list — never the moved
 * row alone, because an insertion between siblings cannot be represented by a single integer.
 * Idempotent by construction: repeating the same payload converges to the same parent link and the
 * same indices, so a retry after an ambiguous failure cannot corrupt the order.
 *
 * Directus has no multi-statement transaction, so the write is deliberately not claimed atomic: a
 * mid-flight failure raises `TaskServiceError` (answered as a generic 500 with the Directus detail
 * logged server-side) and a retry converges.
 */
export class TaskMoveService {
    /**
     * Moves `task` to the destination parent and renumbers the whole sibling list.
     *
     * @param task  The moved node, already loaded through `loadTaskScoped`.
     * @param input The destination parent (`null` = root) and the parent's complete ordered child
     *              list **after** the move, which becomes the stored `(sort_order)` sequence.
     * @returns The moved task in the same wire shape the item route returns.
     */
    static async moveTask(
        actor: ScopedActor,
        permissions: PermissionContext,
        task: ScopedTaskRow,
        input: MoveTaskInput,
    ): Promise<TaskClientRow> {
        const [rows, parentId] = await Promise.all([
            TaskItemService.readDepartmentTreeRows(actor),
            TaskService.resolveParentId(actor, input.parent_id),
        ]);

        const target: MoveTarget = { movedId: task.id, parentId, siblingIds: input.sibling_ids };
        TaskMoveService.assertMoveTarget(rows, target);
        await TaskMoveService.writeSiblingOrder(actor, target);

        // The two structural facts a move can change, logged after the write. `buildTaskActivityDeltas`
        // drops whichever side did not actually move, so a pure reorder records no `parent_id` row and
        // a re-parent at the same index records no `sort_order` row. The old `sort_order` is the value
        // the loaded row carried — the stored index — and the new one is the moved node's position in
        // the sibling list that was just written.
        await TaskActivityService.record(actor, task.id, "updated", [
            buildActivityChange({
                field_key: "parent_id",
                field_label: TASK_ACTIVITY_FIELD_LABELS.parent_id,
                old_value: task.parent_id,
                new_value: parentId,
            }),
            buildActivityChange({
                field_key: "sort_order",
                field_label: TASK_ACTIVITY_FIELD_LABELS.sort_order,
                old_value: task.sort_order,
                new_value: input.sibling_ids.indexOf(task.id),
            }),
        ]);

        const moved = await loadTaskScoped(actor, task.id);
        if (moved === null) {
            throw new TaskServiceError("INTERNAL_FAIL", "The task was moved but could not be read back");
        }
        return TaskItemService.readTask(actor, permissions, moved);
    }

    /**
     * Every 400 of the move contract, in order: the target parent is neither the moved node itself
     * nor one of its descendants; the sibling list names the moved node exactly once; every entry is
     * a live task of the actor's department; and the list is exactly the target parent's complete
     * post-move child set. The target parent itself was validated by `resolveParentId` already.
     */
    private static assertMoveTarget(rows: readonly TreeSourceRow[], target: MoveTarget): void {
        const { movedId, parentId, siblingIds } = target;

        if (parentId !== null) {
            if (parentId === movedId) {
                throw new TaskServiceError("VALIDATION_FAILED", "A task cannot be made its own parent");
            }
            if (isDescendant(rows, movedId, parentId)) {
                throw new TaskServiceError(
                    "VALIDATION_FAILED",
                    "A task cannot be moved under one of its own descendants",
                );
            }
        }

        if (!containsExactlyOnce(siblingIds, movedId)) {
            throw new TaskServiceError("VALIDATION_FAILED", "The sibling list must contain the moved task exactly once");
        }

        const liveIds = new Set(rows.map((row) => row.id));
        for (const siblingId of siblingIds) {
            if (!liveIds.has(siblingId)) {
                throw new TaskServiceError("VALIDATION_FAILED", "Every sibling must be an existing task in your department");
            }
        }

        if (!isCompletePostMoveChildSet(rows, movedId, parentId, siblingIds)) {
            throw new TaskServiceError(
                "VALIDATION_FAILED",
                "The sibling list must be the target parent's complete child list, in the new order",
            );
        }
    }

    /**
     * One bulk `PATCH` for the whole sibling list: each entry stores its array index as
     * `sort_order`, and the moved entry additionally stores its new `parent_id`. Every entry also
     * takes the same `updated_at` / `updated_by` pair, so the audit trail names the actor on every
     * row the move touched. A failure is logged with the Directus detail and re-raised as a coded
     * error; a retry of the same payload converges.
     */
    private static async writeSiblingOrder(actor: ScopedActor, target: MoveTarget): Promise<void> {
        const { movedId, parentId, siblingIds } = target;
        const now = phNow();
        const items = siblingIds.map((siblingId, index) => ({
            id: siblingId,
            sort_order: index,
            ...(siblingId === movedId ? { parent_id: parentId } : {}),
            updated_at: now,
            updated_by: actor.userId,
        }));

        try {
            await updateItems<unknown>("pm_task", items);
        } catch (error) {
            console.error(
                `[tasks move] renumbering ${items.length} sibling(s) for task ${movedId} failed; the move may be partial:`,
                error,
            );
            throw new TaskServiceError("INTERNAL_FAIL", "The task could not be moved; retry the move to finish it");
        }
    }
}

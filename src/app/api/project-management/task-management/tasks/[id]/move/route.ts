import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/services/actor-service";
import {
    PermissionError,
    assertCanMove,
    getPermissionContext,
} from "@/modules/project-management/services/permission-service";
import { loadTaskScoped } from "@/modules/project-management/services/scoping";
import { TaskServiceError } from "@/modules/project-management/task-management/tasks/services/task-service";
import { TaskMoveService } from "@/modules/project-management/task-management/tasks/services/task-move-service";
import { MoveTaskSchema } from "@/modules/project-management/task-management/tasks/types/pm-task.schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The move route — reorder and re-parent, the drop handler behind the task tree.
 *
 * `PATCH /api/project-management/task-management/tasks/<id>/move` with body `MoveTaskSchema`:
 * `{ parent_id: number | null, sibling_ids: number[] }`. `parent_id: null` means "move to root" and
 * is valid — it is not a missing parent. `sibling_ids` is the destination parent's COMPLETE ordered
 * child list **after** the move, including the moved node; its order becomes the stored sequence.
 *
 * Contract, in order:
 * 1. The actor resolves first: 401 without a session, 403 without a department.
 * 2. `loadTaskScoped(actor, id)` loads the **moved node** — `null` is a 404 before any capability
 *    check, so absent, soft-deleted and another department's rows stay indistinguishable.
 * 3. `MoveTaskSchema` validates the body, then `assertCanMove` runs (the matrix defines move as
 *    `canEdit`, so this is never an independent gate).
 * 4. The service refuses with 400 when the target parent is missing as a live row, is not in the
 *    actor's department, **is the moved node itself** (`isDescendant` is deliberately strict and
 *    answers `false` for `x` vs `x`, so self-parenting is rejected explicitly or a cycle slips
 *    through), or is a descendant of the moved node; when `sibling_ids` does not contain the moved
 *    node exactly once or contains duplicates; when any entry is not a live row of the actor's
 *    department; or when the list is not exactly the target parent's complete post-move live child
 *    set — the rule that keeps unlisted siblings from holding stale `sort_order` values.
 * 5. One bulk `PATCH pm_task` writes the moved node's new `parent_id` and `sort_order = index` for
 *    **every** sibling in the sent order (never the moved row alone), plus `updated_at` from
 *    `phNow()` and `updated_by` from the actor. The client's cycle guard is UX only: this route is
 *    the truth, and a retry of the same payload converges to the same state.
 *
 * -> 200 `{ success, data: row }`, the same wire row the item route returns (nested rows, resolved
 * catalog labels, `can_delete`). `department_id`, `created_by`, `updated_by` and both timestamps
 * can never be set from a body — the schema strips unknown keys and the audit columns are injected
 * from the actor. Directus failures are logged here and answered with the module's own envelope,
 * never raw Directus text.
 */

/** The actor, or the envelope the handler must return instead: 401 without a session, 403 without a department. */
type ActorResolution =
    | { readonly resolved: true; readonly actor: ScopedActor }
    | { readonly resolved: false; readonly response: NextResponse };

/** A parsed body, or the 400 envelope explaining why it could not be parsed. */
type BodyResult<T> =
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly response: NextResponse };

function badRequest(message: string): NextResponse {
    return NextResponse.json({ success: false, message }, { status: 400 });
}

function notFound(message: string): NextResponse {
    return NextResponse.json({ success: false, message }, { status: 404 });
}

async function resolveTaskActor(): Promise<ActorResolution> {
    const actor = await resolveActor();
    if (actor === null) {
        return { resolved: false, response: NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 }) };
    }
    if (!isScopedActor(actor)) {
        return {
            resolved: false,
            response: NextResponse.json(
                { success: false, message: "Forbidden: your account is not assigned to a department" },
                { status: 403 },
            ),
        };
    }
    return { resolved: true, actor };
}

/** Zod-first body parsing: a body that is not JSON, or fails the schema, is a 400 — never a 500. */
async function parseBody<T>(req: NextRequest, schema: z.ZodType<T>): Promise<BodyResult<T>> {
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        return { ok: false, response: badRequest("Request body must be valid JSON") };
    }

    const validation = schema.safeParse(raw);
    if (!validation.success) {
        return {
            ok: false,
            response: NextResponse.json(
                { success: false, message: "Validation failed", errors: validation.error.flatten().fieldErrors },
                { status: 400 },
            ),
        };
    }
    return { ok: true, data: validation.data };
}

/** Maps a thrown error to the envelope. Raw Directus text is logged server-side, never returned. */
function failureResponse(scope: string, error: unknown): NextResponse {
    if (error instanceof PermissionError) {
        return NextResponse.json({ success: false, message: error.message }, { status: 403 });
    }
    if (error instanceof TaskServiceError) {
        if (error.code === "NOT_FOUND") {
            return NextResponse.json({ success: false, message: error.message }, { status: 404 });
        }
        if (error.code === "VALIDATION_FAILED") {
            return NextResponse.json({ success: false, message: error.message }, { status: 400 });
        }
        console.error(`[tasks ${scope}] task operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The task operation could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[tasks ${scope}] unexpected error:`, error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
    try {
        const { id } = await params;
        const resolution = await resolveTaskActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        const task = await loadTaskScoped(actor, id);
        if (task === null) return notFound("Task not found");

        const body = await parseBody(req, MoveTaskSchema);
        if (!body.ok) return body.response;

        await assertCanMove(actor, task);

        const permissions = await getPermissionContext(actor);
        const row = await TaskMoveService.moveTask(actor, permissions, task, body.data);

        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("MOVE", error);
    }
}

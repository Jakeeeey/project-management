import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/services/actor-service";
import { PermissionError, assertCanAssign } from "@/modules/project-management/services/permission-service";
import { loadTaskScoped } from "@/modules/project-management/services/scoping";
import { AssigneeService } from "@/modules/project-management/tasks/services/assignee-service";
import { TaskServiceError } from "@/modules/project-management/tasks/services/task-service";
import { AssigneeMutationSchema } from "@/modules/project-management/tasks/types/pm-task.schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The task-assignees route — put a department member on a task, or take them off.
 *
 * Every handler runs the department guard FIRST: `loadTaskScoped(actor, id)` returns a live row of
 * the actor's own department or `null`, and `null` is answered with 404 before any capability check
 * or body read — absent, soft-deleted and another department's tasks stay indistinguishable.
 *
 * Contract — both verbs take the SAME body, `AssigneeMutationSchema` = `{ user_id }`:
 * - `POST` -> 200 `{ success, data: row }`. `assertCanAssign` (head or granted assigner, never a
 *   role string) runs before the body is parsed; the service then requires the target to be a live
 *   member of the actor's own department (404 otherwise) and runs REVIVE-OR-INSERT:
 *   `uq_pm_task_assignee (task_id, user_id)` exists and ignores `is_deleted`, so a re-assign after
 *   an unassign revives the existing row, never blind-INSERTs it. **200 rather than 201,
 *   deliberately** — the call is a state request that may revive a row, so there is no single
 *   "created" answer, and the row count for the pair stays exactly one.
 * - `DELETE` -> 200 `{ success, data: row }` with `is_deleted: 1`. `assertCanAssign` runs first
 *   here too — the matrix restricts *assign or unassign* to the same actors — then the live row is
 *   loaded scoped by `department_id = actor.departmentId`; a miss is a 404 and every row is left
 *   untouched. Soft delete only: the row survives so the next assign can revive it.
 *
 * `department_id`, `created_by`, `updated_by` and both timestamps are injected server-side from the
 * actor and `phNow()`; the Zod schema strips unknown keys, so a body carrying them is ignored
 * rather than honoured. Directus failures are logged here and answered with the module's own
 * message — raw Directus text never reaches a client.
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
        console.error(`[task-assignees ${scope}] assignment failed:`, error);
        return NextResponse.json(
            { success: false, message: "The assignment could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[task-assignees ${scope}] unexpected error:`, error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function POST(
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

        await assertCanAssign(actor);

        const body = await parseBody(req, AssigneeMutationSchema);
        if (!body.ok) return body.response;

        const row = await AssigneeService.assign(actor, task, body.data);

        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("POST", error);
    }
}

export async function DELETE(
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

        await assertCanAssign(actor);

        const body = await parseBody(req, AssigneeMutationSchema);
        if (!body.ok) return body.response;

        const row = await AssigneeService.unassign(actor, task, body.data);

        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("DELETE", error);
    }
}

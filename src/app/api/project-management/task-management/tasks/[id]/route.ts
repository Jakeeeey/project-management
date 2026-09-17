import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/services/actor-service";
import {
    PermissionError,
    assertCanDelete,
    assertCanEdit,
    getPermissionContext,
} from "@/modules/project-management/services/permission-service";
import { loadTaskScoped } from "@/modules/project-management/services/scoping";
import { TaskServiceError } from "@/modules/project-management/task-management/tasks/services/task-service";
import { TaskFieldError } from "@/modules/project-management/task-management/tasks/services/task-field-service";
import { TaskItemService } from "@/modules/project-management/task-management/tasks/services/task-item-service";
import { UpdateTaskSchema } from "@/modules/project-management/task-management/tasks/types/pm-task.schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The task item route — one task, read, updated, or soft-deleted with its subtree.
 *
 * Every handler runs the department guard FIRST: `loadTaskScoped(actor, id)` returns a live row of
 * the actor's department or `null`, and `null` is answered with 404 before any capability check —
 * absent, soft-deleted and another department's rows are deliberately indistinguishable.
 *
 * Contract:
 * - `GET` -> 200 `{ success, data: row }` — the same wire row the list route returns: stored
 *   columns, live nested assignees/attachments, status/priority labels resolved from live catalog
 *   rows (unresolved -> `null`), and the server-computed `can_delete`.
 * - `PATCH` body `UpdateTaskSchema` -> 200 `{ success, data: row }`. `assertCanEdit` runs first
 *   (every member may edit); only changed fields plus `updated_at` / `updated_by` are written; a
 *   supplied `status_id` / `priority_id` must be a live catalog row of the actor's department (400
 *   otherwise, and not re-validated when unchanged); `end_date >= start_date` is checked on the
 *   merged pair. `parent_id` cannot be patched — re-parenting belongs to the move route.
 * - `DELETE` -> 200 `{ success, data: { id, deleted_ids } }`. `assertCanDelete(actor, task)` is
 *   row-aware (head or granted assigner, else the task's creator — the exact predicate behind the
 *   row's `can_delete`), then the whole subtree is soft-deleted leaf-first: best-effort, never
 *   claimed atomic, and a partial failure is a 500 rather than a success.
 *
 * `department_id`, `created_by`, `updated_by` and both timestamps can never be set from a body: the
 * Zod schema strips unknown keys and the audit columns are injected from the actor and `phNow()`.
 * Directus failures are logged here and answered with the module's own message, never raw text.
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
    // A custom-column refusal (an unknown column, a bad value for the column's type, a choice the
    // column does not offer) is a client error, not an outage — it must not fall through to the 500.
    if (error instanceof TaskFieldError) {
        if (error.code === "NOT_FOUND") {
            return NextResponse.json({ success: false, message: error.message }, { status: 404 });
        }
        if (error.code === "VALIDATION_FAILED") {
            return NextResponse.json({ success: false, message: error.message }, { status: 400 });
        }
        console.error(`[tasks ${scope}] custom-column operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The custom-column operation could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[tasks ${scope}] unexpected error:`, error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
    try {
        const { id } = await params;
        const resolution = await resolveTaskActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        const task = await loadTaskScoped(actor, id);
        if (task === null) return notFound("Task not found");

        const permissions = await getPermissionContext(actor);
        const row = await TaskItemService.readTask(actor, permissions, task);

        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("GET", error);
    }
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

        await assertCanEdit(actor);

        const body = await parseBody(req, UpdateTaskSchema);
        if (!body.ok) return body.response;

        const permissions = await getPermissionContext(actor);
        const row = await TaskItemService.updateTask(actor, permissions, task, body.data);

        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("PATCH", error);
    }
}

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
    try {
        const { id } = await params;
        const resolution = await resolveTaskActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        const task = await loadTaskScoped(actor, id);
        if (task === null) return notFound("Task not found");

        await assertCanDelete(actor, task);

        const deleted = await TaskItemService.deleteTaskSubtree(actor, task);

        return NextResponse.json({ success: true, data: deleted });
    } catch (error) {
        return failureResponse("DELETE", error);
    }
}

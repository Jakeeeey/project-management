import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/task-management/tasks/services/actor-service";
import { PermissionError, assertCanEdit } from "@/modules/project-management/task-management/tasks/services/permission-service";
import { loadTaskScoped } from "@/modules/project-management/task-management/tasks/services/scoping";
import { TagService, TagServiceError } from "@/modules/project-management/task-management/tasks/services/tag-service";
import { TaskTagMutationSchema } from "@/modules/project-management/task-management/tasks/types/tag.schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The task-tags route — attach one tag to a task, or detach it.
 *
 * Every handler runs the department guard FIRST: `loadTaskScoped(actor, id)` returns a live row of
 * the actor's own department or `null`, and `null` is answered with 404 before any capability check
 * or body read — absent, soft-deleted and another department's tasks stay indistinguishable.
 *
 * Contract — both verbs take the SAME body, `TaskTagMutationSchema` = `{ tag_id }`:
 * - `POST` -> 200 `{ success, data: { tag_id } }`. `assertCanEdit(actor, task)` (the row-aware
 *   edit predicate, exactly what the task payload's `can_edit` reports) runs before the body is
 *   parsed; the service then requires the tag to be a live row of the actor's own department (404
 *   otherwise) and attaches REVIVE-OR-INSERT: `(task_id, tag_id)` ignores `is_deleted`, so a re-add
 *   after a detach revives the row instead of duplicating it. 200 rather than 201 for the same
 *   reason as the assignees route: the call is a state request, not a guaranteed create.
 * - `DELETE` -> 200 `{ success, data: { tag_id } }` with the link soft-deleted. The live link is
 *   loaded scoped by `department_id`; a miss is a 404 and nothing is written.
 *
 * Failures are logged here and answered with the module's own message — raw Directus text never
 * reaches a client. A deployment whose `pm_task_tag` table has not been created yet answers this
 * route with a 500 (there is nothing to attach to); the task READ paths degrade instead.
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
    if (error instanceof TagServiceError) {
        if (error.code === "NOT_FOUND") {
            return NextResponse.json({ success: false, message: error.message }, { status: 404 });
        }
        if (error.code === "VALIDATION_FAILED") {
            return NextResponse.json({ success: false, message: error.message }, { status: 400 });
        }
        console.error(`[task-tags ${scope}] tag operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The tag could not be saved on the task. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[task-tags ${scope}] unexpected error:`, error);
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

        await assertCanEdit(actor, task);

        const body = await parseBody(req, TaskTagMutationSchema);
        if (!body.ok) return body.response;

        const row = await TagService.assign(actor, task, body.data);

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

        await assertCanEdit(actor, task);

        const body = await parseBody(req, TaskTagMutationSchema);
        if (!body.ok) return body.response;

        const row = await TagService.unassign(actor, task, body.data);

        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("DELETE", error);
    }
}

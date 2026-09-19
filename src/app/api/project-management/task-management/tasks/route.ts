import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/task-management/tasks/services/actor-service";
import {
    PermissionError,
    assertCanCreate,
    getPermissionContext,
} from "@/modules/project-management/task-management/tasks/services/permission-service";
import { CreateTaskSchema } from "@/modules/project-management/task-management/tasks/types/pm-task.schema";
import { TaskService, TaskServiceError } from "@/modules/project-management/task-management/tasks/services/task-service";
import { TaskListService } from "@/modules/project-management/task-management/tasks/services/task-list-service";
import { loadListScoped } from "@/modules/project-management/task-management/tasks/services/scoping";
import { TaskFieldError } from "@/modules/project-management/task-management/tasks/services/task-field-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The tasks collection route — one list's tasks and task creation.
 *
 * Contract:
 * - `GET ?list_id=<id>` -> 200 `{ success, data, catalogs, capabilities }` where `data` is the
 *   list's **flat** row array (the client assembles the tree from `parent_id`), every row carries
 *   the server-computed `can_delete` plus its status/priority labels resolved from live catalog
 *   rows, `catalogs` carries both per-department lists (their `id`s are what a create references),
 *   and `capabilities` is the coarse session answer. The read is scoped by department AND list: an
 *   explicit `list_id` must be a live list of the actor's department (a miss is 404, never 403, so
 *   another department's list is never confirmed) and an omitted one falls back to the
 *   department's default list. A session with no department is 403; no session is 401.
 * - `POST` body `CreateTaskSchema` -> 201 `{ success, data: row }`. `assertCanCreate` runs first
 *   (every member may create), a supplied `parent_id` is validated against the actor's department,
 *   `list_id` resolves to a live list (a subtask may only name its parent's list, and inherits it
 *   when omitted; a root task falls back to the default list), and a supplied `status_id` /
 *   `priority_id` must be a live catalog row of that same department, falling back to the kind's
 *   default when omitted. `department_id`, `created_by`, `updated_by`, `created_at` and
 *   `updated_at` are injected server-side from the actor and `phNow()`; the Zod schema strips
 *   unknown keys, so a body carrying them is ignored rather than honoured.
 *
 * The department and list filters are pushed into the Directus query (`filter[department_id][_eq]`,
 * `filter[list_id][_eq]`) — the route never fetches the collection and post-filters. Directus
 * failures are logged here and answered with the module's own message; raw Directus text never
 * reaches a client.
 */

/** The actor, or the envelope the handler must return instead: 401 without a session, 403 without a department. */
type ActorResolution =
    | { readonly resolved: true; readonly actor: ScopedActor }
    | { readonly resolved: false; readonly response: NextResponse };

/** A parsed body, or the 400 envelope explaining why it could not be parsed. */
type BodyResult<T> =
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly response: NextResponse };

/**
 * The list a read is scoped to, or `{ found: false }` when an explicit id names no live list of the
 * actor's department. A `null` id means the department has no live list at all: there is nothing to
 * scope by, so the read answers an empty set rather than an unscoped one.
 */
type ListScope =
    | { readonly found: true; readonly listId: number | null }
    | { readonly found: false };

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

/** Resolves the read scope's list: the requested live list, else the department's default list. */
async function resolveListScope(actor: ScopedActor, requested: string | null): Promise<ListScope> {
    if (requested === null) {
        return { found: true, listId: await TaskListService.resolveDefaultListId(actor) };
    }
    const list = await loadListScoped(actor, requested);
    return list === null ? { found: false } : { found: true, listId: list.id };
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

export async function GET(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveTaskActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        const scope = await resolveListScope(actor, new URL(req.url).searchParams.get("list_id"));
        if (!scope.found) return notFound("Task list not found");

        const permissions = await getPermissionContext(actor);
        const { rows, catalogs, fields } = await TaskService.listDepartmentTasks(actor, permissions, scope.listId);

        return NextResponse.json({
            success: true,
            data: rows,
            catalogs,
            fields,
            capabilities: permissions.capabilitiesForClient(),
        });
    } catch (error) {
        return failureResponse("GET", error);
    }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveTaskActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanCreate(actor);

        const body = await parseBody(req, CreateTaskSchema);
        if (!body.ok) return body.response;

        const permissions = await getPermissionContext(actor);
        const row = await TaskService.createTask(actor, permissions, body.data);
        return NextResponse.json({ success: true, data: row }, { status: 201 });
    } catch (error) {
        return failureResponse("POST", error);
    }
}

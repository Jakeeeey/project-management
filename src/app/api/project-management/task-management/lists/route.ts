import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/task-management/tasks/services/actor-service";
import {
    PermissionError,
    assertCanManageLists,
    getPermissionContext,
} from "@/modules/project-management/task-management/tasks/services/permission-service";
import {
    CreateTaskListSchema,
    UpdateTaskListSchema,
} from "@/modules/project-management/task-management/tasks/types/task-list.schema";
import { TaskListError, TaskListService } from "@/modules/project-management/task-management/tasks/services/task-list-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The task-lists route — one department's lists, the view dimension tasks are scoped by.
 *
 * The route has no `[id]` segment, so a write carries its target in the body, exactly like the
 * configuration route.
 *
 * Contract:
 * - `GET` -> 200 `{ success, data, capabilities }` — every live list ordered by `(sort_order, id)`.
 *   Every member may read: lists are how tasks are viewed, and a task is only reachable inside one.
 *   A plain member receives `capabilities.canManageDepartmentSetting: false`, which is what hides
 *   the list-management controls.
 * - `POST` body `{ name, sort_order? }` -> 201 `{ success, data: row }`.
 * - `PATCH` body `{ id, name?, sort_order? }` -> 200 `{ success, data: row }`.
 * - `DELETE` body `{ id }` -> 200 `{ success, data: row }` with `is_deleted: 1` (soft delete only;
 *   the default list and the last live list are refused).
 *
 * Every handler resolves the actor first (401 without a session, 403 with a null department), every
 * write requires `assertCanManageLists` — the module's existing HEAD-ONLY capability, never a role
 * string and never the weaker configure flag — and every named row is loaded through
 * `loadListScoped` inside the service, where a miss becomes 404 so another department's list is
 * never confirmed. `department_id`, `is_default` and all audit columns are injected server-side
 * from the actor; the Zod schemas strip unknown keys, so a body carrying them is ignored rather
 * than honoured.
 */

const ListRowIdSchema = z.number().int().positive();

/** PATCH body: the row to address plus only the fields that changed. */
const UpdateTaskListBodySchema = UpdateTaskListSchema.extend({ id: ListRowIdSchema });

/** DELETE body: the row to soft-delete. */
const DeleteTaskListBodySchema = z.object({ id: ListRowIdSchema });

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

async function resolveListActor(): Promise<ActorResolution> {
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
    if (error instanceof TaskListError) {
        if (error.code === "NOT_FOUND") {
            return NextResponse.json({ success: false, message: error.message }, { status: 404 });
        }
        if (error.code === "VALIDATION_FAILED") {
            return NextResponse.json({ success: false, message: error.message }, { status: 400 });
        }
        console.error(`[task-lists ${scope}] list operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The task-list operation could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[task-lists ${scope}] unexpected error:`, error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function GET(): Promise<NextResponse> {
    try {
        const resolution = await resolveListActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        const [lists, permissions] = await Promise.all([
            TaskListService.listLists(actor),
            getPermissionContext(actor),
        ]);

        return NextResponse.json({
            success: true,
            data: lists,
            capabilities: permissions.capabilitiesForClient(),
        });
    } catch (error) {
        return failureResponse("GET", error);
    }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveListActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanManageLists(actor);

        const body = await parseBody(req, CreateTaskListSchema);
        if (!body.ok) return body.response;

        const created = await TaskListService.create(actor, body.data);
        return NextResponse.json({ success: true, data: created }, { status: 201 });
    } catch (error) {
        return failureResponse("POST", error);
    }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveListActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanManageLists(actor);

        const body = await parseBody(req, UpdateTaskListBodySchema);
        if (!body.ok) return body.response;

        const { id, ...changes } = body.data;
        const updated = await TaskListService.update(actor, id, changes);
        return NextResponse.json({ success: true, data: updated });
    } catch (error) {
        return failureResponse("PATCH", error);
    }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveListActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanManageLists(actor);

        const body = await parseBody(req, DeleteTaskListBodySchema);
        if (!body.ok) return body.response;

        const removed = await TaskListService.softDelete(actor, body.data.id);
        return NextResponse.json({ success: true, data: removed });
    } catch (error) {
        return failureResponse("DELETE", error);
    }
}

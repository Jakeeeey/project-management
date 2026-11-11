import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/task-management/tasks/services/actor-service";
import {
    PermissionError,
    assertCanConfigure,
    getPermissionContext,
} from "@/modules/project-management/task-management/tasks/services/permission-service";
import { TagService, TagServiceError } from "@/modules/project-management/task-management/tasks/services/tag-service";
import { CreateTagSchema, UpdateTagSchema } from "@/modules/project-management/task-management/tasks/types/tag.schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The department tag catalog route.
 *
 * Contract:
 * - `GET` -> 200 `{ success, data: tag[], capabilities }` — live rows only, ordered by
 *   `(sort_order, id)`. Every member may read (the tasks page renders tags), and a plain member
 *   receives `capabilities.canConfigure: false`, which is what hides the Settings section.
 * - `POST` body `{ label, color?, sort_order? }` -> 201 `{ success, data: row }`. A label already
 *   carried by a live row is a 400; a label whose row is only soft-deleted REVIVES that row.
 * - `PATCH` body `{ id, label?, color?, sort_order? }` -> 200 `{ success, data: row }`.
 * - `DELETE` body `{ id }` -> 200 `{ success, data: row }` with the tag soft-deleted (never removed,
 *   so the next create with the same label revives it).
 *
 * The route has no `[id]` segment, so every write names its target in the body — the same shape the
 * configuration route uses. `department_id` and all audit columns are injected server-side from the
 * actor; the Zod schemas strip unknown keys, so a body carrying them is ignored rather than honoured.
 */

const TagRowIdSchema = z.number().int().positive();

const UpdateTagBodySchema = UpdateTagSchema.extend({ id: TagRowIdSchema });

const DeleteTagBodySchema = z.object({ id: TagRowIdSchema });

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

async function resolveTagActor(): Promise<ActorResolution> {
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
        console.error(`[tags ${scope}] tag operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The tag could not be saved. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[tags ${scope}] unexpected error:`, error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function GET(): Promise<NextResponse> {
    try {
        const resolution = await resolveTagActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        const [tags, permissions] = await Promise.all([TagService.list(actor), getPermissionContext(actor)]);

        return NextResponse.json({
            success: true,
            data: tags,
            capabilities: permissions.capabilitiesForClient(),
        });
    } catch (error) {
        return failureResponse("GET", error);
    }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveTagActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanConfigure(actor);

        const body = await parseBody(req, CreateTagSchema);
        if (!body.ok) return body.response;

        const row = await TagService.create(actor, body.data);
        return NextResponse.json({ success: true, data: row }, { status: 201 });
    } catch (error) {
        return failureResponse("POST", error);
    }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveTagActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanConfigure(actor);

        const body = await parseBody(req, UpdateTagBodySchema);
        if (!body.ok) return body.response;

        const { id, ...changes } = body.data;
        const row = await TagService.update(actor, id, changes);
        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("PATCH", error);
    }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveTagActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanConfigure(actor);

        const body = await parseBody(req, DeleteTagBodySchema);
        if (!body.ok) return body.response;

        const row = await TagService.softDelete(actor, body.data.id);
        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("DELETE", error);
    }
}

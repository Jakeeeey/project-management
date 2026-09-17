import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/services/actor-service";
import {
    PermissionError,
    assertCanConfigure,
    getPermissionContext,
} from "@/modules/project-management/services/permission-service";
import {
    CreateTaskFieldOptionSchema,
    CreateTaskFieldSchema,
    UpdateTaskFieldOptionSchema,
    UpdateTaskFieldSchema,
} from "@/modules/project-management/task-management/tasks/types/task-field.schema";
import {
    TaskFieldError,
    TaskFieldService,
} from "@/modules/project-management/task-management/tasks/services/task-field-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The custom-column builder route — one department's own columns on the task list, and the choices a
 * `select` column offers.
 *
 * `kind: "field" | "option"` is mandatory on every write: a column and a choice are different tables
 * with independent auto-increment id spaces, so a bare id names two different rows. The route has no
 * `[id]` segment, so a write carries its target in the body.
 *
 * Contract:
 * - `GET` -> 200 `{ success, data: fields, capabilities }` where `fields` is every live column with
 *   its live choices, ordered by `(sort_order, id)`. Every member may read — the task list renders
 *   the columns and resolves each cell's choice label from this payload — and a plain member
 *   receives `capabilities.canConfigure: false`, which is what hides the builder.
 * - `POST` body `{ kind: "field", label, field_type, sort_order? }` -> 201 `{ success, data }`.
 * - `POST` body `{ kind: "option", field_id, label, sort_order? }` -> 201 `{ success, data }`.
 * - `PATCH` body `{ kind: "field", id, label?, sort_order? }` -> 200. A column's `field_type` is not
 *   patchable — see `task-field.schema.ts`.
 * - `PATCH` body `{ kind: "option", id, label?, sort_order? }` -> 200.
 * - `DELETE` body `{ kind, id }` -> 200 with `is_deleted: 1` (soft delete only). Removing a column
 *   also soft-deletes its choices; the tasks' stored answers are deliberately left alone.
 *
 * Every handler resolves the actor first (401 without a session, 403 with a null department), every
 * write requires `assertCanConfigure` (head or granted assigner — never a role string), and every
 * named row is loaded through the scoped loaders inside the service, where a miss becomes 404 so
 * another department's row is never confirmed. `department_id` and all audit columns are injected
 * server-side from the actor; the Zod schemas strip unknown keys, so a body carrying them is ignored
 * rather than honoured.
 */

const RowIdSchema = z.number().int().positive();

/** POST body: the discriminator plus a new column or choice. */
const CreateBodySchema = z.discriminatedUnion("kind", [
    CreateTaskFieldSchema.extend({ kind: z.literal("field") }),
    CreateTaskFieldOptionSchema.extend({ kind: z.literal("option") }),
]);

/** PATCH body: the discriminator, the row to address, and only the fields that changed. */
const UpdateBodySchema = z.discriminatedUnion("kind", [
    UpdateTaskFieldSchema.extend({ kind: z.literal("field"), id: RowIdSchema }),
    UpdateTaskFieldOptionSchema.extend({ kind: z.literal("option") }),
]);

/** DELETE body: the discriminator plus the row to soft-delete. */
const DeleteBodySchema = z.object({ kind: z.enum(["field", "option"]), id: RowIdSchema });

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

async function resolveFieldActor(): Promise<ActorResolution> {
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
    if (error instanceof TaskFieldError) {
        if (error.code === "NOT_FOUND") {
            return NextResponse.json({ success: false, message: error.message }, { status: 404 });
        }
        if (error.code === "VALIDATION_FAILED") {
            return NextResponse.json({ success: false, message: error.message }, { status: 400 });
        }
        console.error(`[task-fields ${scope}] custom-column operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The custom-column operation could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[task-fields ${scope}] unexpected error:`, error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function GET(): Promise<NextResponse> {
    try {
        const resolution = await resolveFieldActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        const [fields, permissions] = await Promise.all([
            TaskFieldService.listFields(actor),
            getPermissionContext(actor),
        ]);

        return NextResponse.json({
            success: true,
            data: fields,
            capabilities: permissions.capabilitiesForClient(),
        });
    } catch (error) {
        return failureResponse("GET", error);
    }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveFieldActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanConfigure(actor);

        const body = await parseBody(req, CreateBodySchema);
        if (!body.ok) return body.response;

        if (body.data.kind === "field") {
            const created = await TaskFieldService.createField(actor, {
                label: body.data.label,
                field_type: body.data.field_type,
                sort_order: body.data.sort_order,
            });
            return NextResponse.json({ success: true, data: created }, { status: 201 });
        }

        const created = await TaskFieldService.createOption(actor, {
            field_id: body.data.field_id,
            label: body.data.label,
            sort_order: body.data.sort_order,
        });
        return NextResponse.json({ success: true, data: created }, { status: 201 });
    } catch (error) {
        return failureResponse("POST", error);
    }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveFieldActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanConfigure(actor);

        const body = await parseBody(req, UpdateBodySchema);
        if (!body.ok) return body.response;

        if (body.data.kind === "field") {
            const updated = await TaskFieldService.updateField(actor, body.data.id, body.data);
            return NextResponse.json({ success: true, data: updated });
        }

        const updated = await TaskFieldService.updateOption(actor, body.data.id, body.data);
        return NextResponse.json({ success: true, data: updated });
    } catch (error) {
        return failureResponse("PATCH", error);
    }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveFieldActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanConfigure(actor);

        const body = await parseBody(req, DeleteBodySchema);
        if (!body.ok) return body.response;

        const removed =
            body.data.kind === "field"
                ? await TaskFieldService.softDeleteField(actor, body.data.id)
                : await TaskFieldService.softDeleteOption(actor, body.data.id);

        return NextResponse.json({ success: true, data: removed });
    } catch (error) {
        return failureResponse("DELETE", error);
    }
}
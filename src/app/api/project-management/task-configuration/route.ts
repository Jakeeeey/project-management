import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/services/actor-service";
import {
    PermissionError,
    assertCanConfigure,
    getPermissionContext,
} from "@/modules/project-management/services/permission-service";
import {
    CatalogKindSchema,
    CreateCatalogItemSchema,
    UpdateCatalogItemSchema,
} from "@/modules/project-management/task-configuration/types/task-config.schema";
import { TaskConfigError, TaskConfigService } from "@/modules/project-management/task-configuration/services/task-config-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The task-configuration route — one department's status and priority catalog.
 *
 * `kind: "status" | "priority"` is mandatory on every write: `pm_task_status` and `pm_task_priority`
 * are separate tables with independent auto-increment id spaces, so a bare id names two different
 * rows. The route has no `[id]` segment, so a write carries its target in the body.
 *
 * Contract:
 * - `GET` -> 200 `{ success, data: { statuses, priorities }, capabilities }` — live rows only,
 *   ordered by `(sort_order, id)`. Every member may read; a plain member receives
 *   `capabilities.canConfigure: false`, which is what hides the Settings section.
 * - `POST` body `{ kind, label, color?, sort_order?, is_default? }` -> 201 `{ success, data: row }`.
 * - `POST ?action=seed-defaults` (the explicit seed action, never implicit on load) -> 200
 *   `{ success, data: { statusesCreated, prioritiesCreated } }`; idempotent, so a second call
 *   reports zero.
 * - `PATCH` body `{ kind, id, label?, color?, sort_order?, is_default? }` -> 200 `{ success, data: row }`.
 * - `DELETE` body `{ kind, id }` -> 200 `{ success, data: row }` with `is_deleted: 1` (soft delete only).
 *
 * Every handler resolves the actor first (401 without a session, 403 with a null department), every
 * write requires `assertCanConfigure` (head or granted assigner — never a role string), and every
 * named row is loaded through `loadConfigScoped(actor, kind, id)` inside the service, where a miss
 * becomes 404 so another department's row is never confirmed. `department_id` and all audit columns
 * are injected server-side from the actor; the Zod schemas strip unknown keys, so a body carrying
 * them is ignored rather than honoured.
 */

const CatalogRowIdSchema = z.number().int().positive();

/** POST body: the discriminator plus a new catalog row. */
const CreateCatalogBodySchema = CreateCatalogItemSchema.extend({ kind: CatalogKindSchema });

/** PATCH body: the discriminator, the row to address, and only the fields that changed. */
const UpdateCatalogBodySchema = UpdateCatalogItemSchema.extend({ kind: CatalogKindSchema, id: CatalogRowIdSchema });

/** DELETE body: the discriminator plus the row to soft-delete. */
const DeleteCatalogBodySchema = z.object({ kind: CatalogKindSchema, id: CatalogRowIdSchema });

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

async function resolveConfigActor(): Promise<ActorResolution> {
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
    if (error instanceof TaskConfigError) {
        if (error.code === "NOT_FOUND") {
            return NextResponse.json({ success: false, message: error.message }, { status: 404 });
        }
        if (error.code === "VALIDATION_FAILED") {
            return NextResponse.json({ success: false, message: error.message }, { status: 400 });
        }
        console.error(`[task-configuration ${scope}] catalog operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The catalog operation could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[task-configuration ${scope}] unexpected error:`, error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveConfigActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        if (new URL(req.url).searchParams.has("action")) {
            return badRequest("The action query parameter is only supported on POST: use POST ?action=seed-defaults");
        }

        const [catalogs, permissions] = await Promise.all([
            TaskConfigService.listCatalog(actor),
            getPermissionContext(actor),
        ]);

        return NextResponse.json({
            success: true,
            data: catalogs,
            capabilities: permissions.capabilitiesForClient(),
        });
    } catch (error) {
        return failureResponse("GET", error);
    }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveConfigActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanConfigure(actor);

        if (new URL(req.url).searchParams.get("action") === "seed-defaults") {
            const seeded = await TaskConfigService.seedDefaults(actor.departmentId, actor.userId);
            const created = seeded.statusesCreated + seeded.prioritiesCreated;
            return NextResponse.json({
                success: true,
                data: seeded,
                message:
                    created === 0
                        ? "This department already owns live status and priority rows; nothing was seeded"
                        : `Seeded ${seeded.statusesCreated} statuses and ${seeded.prioritiesCreated} priorities`,
            });
        }

        const body = await parseBody(req, CreateCatalogBodySchema);
        if (!body.ok) return body.response;

        const { kind, ...input } = body.data;
        const row = await TaskConfigService.create(actor, kind, input);
        return NextResponse.json({ success: true, data: row }, { status: 201 });
    } catch (error) {
        return failureResponse("POST", error);
    }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveConfigActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanConfigure(actor);

        const body = await parseBody(req, UpdateCatalogBodySchema);
        if (!body.ok) return body.response;

        const { kind, id, ...changes } = body.data;
        const row = await TaskConfigService.update(actor, kind, id, changes);
        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("PATCH", error);
    }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveConfigActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanConfigure(actor);

        const body = await parseBody(req, DeleteCatalogBodySchema);
        if (!body.ok) return body.response;

        const row = await TaskConfigService.softDelete(actor, body.data.kind, body.data.id);
        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("DELETE", error);
    }
}

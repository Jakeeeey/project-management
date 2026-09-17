import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/services/actor-service";
import {
    PermissionError,
    assertCanGrant,
    getPermissionContext,
} from "@/modules/project-management/services/permission-service";
import { GrantAssignerSchema, RevokeAssignerSchema } from "@/modules/project-management/assignment-grants/types/grant.schema";
import { GrantError, GrantService } from "@/modules/project-management/assignment-grants/services/grant-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The assignment-grants route — the department's policy of *who may assign*.
 *
 * Contract:
 * - `GET` -> 200 `{ success, data, capabilities }` where `data` is the department's live members
 *   (`GrantService.listMembers`), each carrying `is_granted`, `grant_id` and `granted_by`, and
 *   `capabilities` is the coarse session answer (the `Capabilities` block the Tasks and
 *   Task-Configuration routes also return). The Assignment Grants page gates its grant trigger on
 *   `capabilities.canGrant`. Every member may read. A session with no department is 403; no session
 *   is 401.
 * - `POST` body `GrantAssignerSchema` (`{ user_id }`) -> 200 `{ success, data: row }`. `assertCanGrant`
 *   runs first — HEAD-ONLY; a granted assigner can never grant — then the service requires the target
 *   to be a live member of the actor's own department and runs REVIVE-OR-INSERT:
 *   `uq_pm_assigner (department_id, user_id)` exists and ignores `is_deleted`, so a blind INSERT
 *   after a revoke raises a duplicate-key error. 200 rather than 201 deliberately: the operation may
 *   revive an existing row, so there is no single "created" answer.
 * - `DELETE` body `RevokeAssignerSchema` (`{ id }`) -> 200 `{ success, data: row }` with
 *   `is_deleted: 1` (soft delete only, so the next grant can revive it). `assertCanGrant` runs first,
 *   then the grant row is loaded inside the service scoped by `department_id = actor.departmentId`;
 *   a miss — including another department's row — is a 404, never a 403, so a foreign grant is never
 *   confirmed.
 *
 * `department_id`, `granted_by`, `created_by`, `updated_by`, `created_at` and `updated_at` are
 * injected server-side from the actor and `phNow()`; both Zod schemas strip unknown keys, so a body
 * carrying them is ignored rather than honoured. The service asserts headship on both write paths as
 * well, so the route cannot reach a grant without it. Directus failures are logged here and answered
 * with the module's own message — raw Directus text never reaches a client.
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

async function resolveGrantActor(): Promise<ActorResolution> {
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
    if (error instanceof GrantError) {
        if (error.code === "NOT_FOUND") {
            return NextResponse.json({ success: false, message: error.message }, { status: 404 });
        }
        console.error(`[assignment-grants ${scope}] grant operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The grant operation could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[assignment-grants ${scope}] unexpected error:`, error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function GET(): Promise<NextResponse> {
    try {
        const resolution = await resolveGrantActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        const [members, permissions] = await Promise.all([
            GrantService.listMembers(actor),
            getPermissionContext(actor),
        ]);

        return NextResponse.json({
            success: true,
            data: members,
            capabilities: permissions.capabilitiesForClient(),
        });
    } catch (error) {
        return failureResponse("GET", error);
    }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveGrantActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanGrant(actor);

        const body = await parseBody(req, GrantAssignerSchema);
        if (!body.ok) return body.response;

        const row = await GrantService.grant(actor, body.data);
        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("POST", error);
    }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
    try {
        const resolution = await resolveGrantActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        await assertCanGrant(actor);

        const body = await parseBody(req, RevokeAssignerSchema);
        if (!body.ok) return body.response;

        const row = await GrantService.revoke(actor, body.data.id);
        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return failureResponse("DELETE", error);
    }
}

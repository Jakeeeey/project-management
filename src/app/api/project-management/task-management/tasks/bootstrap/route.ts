import { NextResponse } from "next/server";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/task-management/tasks/services/actor-service";
import { TaskListError, TaskListService } from "@/modules/project-management/task-management/tasks/services/task-list-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The task-list bootstrap route — ensures the department's default "General" list exists.
 *
 * Contract:
 * - `POST` -> 200 `{ success, data: { created, list } }`. Idempotent: the first call of a department
 *   with no live list inserts the fixed "General" row and reports `created: true`; every later call
 *   is a no-op that reports `created: false` and returns the existing default. The request body is
 *   never read.
 *
 * The actor resolves first (401 without a session, 403 without a department), and the route sits
 * under the same middleware/module-grant gate as its siblings. It deliberately carries NO head
 * capability check: the bootstrap writes ONE fixed row — the name, order and default flag are all
 * decided in code — so the actor chooses nothing. The catalog seed is the opposite case and stays
 * explicit and head-gated, because it writes a whole fixture and expresses policy.
 *
 * The department always comes from the resolved actor, never from the request. Directus failures are
 * logged here and answered with the module's own envelope, never raw Directus text.
 */

/** The actor, or the envelope the handler must return instead: 401 without a session, 403 without a department. */
type ActorResolution =
    | { readonly resolved: true; readonly actor: ScopedActor }
    | { readonly resolved: false; readonly response: NextResponse };

async function resolveBootstrapActor(): Promise<ActorResolution> {
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

/** Maps a thrown error to the envelope. Raw Directus text is logged server-side, never returned. */
function failureResponse(error: unknown): NextResponse {
    if (error instanceof TaskListError) {
        if (error.code === "NOT_FOUND") {
            return NextResponse.json({ success: false, message: error.message }, { status: 404 });
        }
        if (error.code === "VALIDATION_FAILED") {
            return NextResponse.json({ success: false, message: error.message }, { status: 400 });
        }
        console.error("[task-lists bootstrap] ensure failed:", error);
        return NextResponse.json(
            { success: false, message: "The default task list could not be ensured. Please try again later." },
            { status: 500 },
        );
    }
    console.error("[task-lists bootstrap] unexpected error:", error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function POST(): Promise<NextResponse> {
    try {
        const resolution = await resolveBootstrapActor();
        if (!resolution.resolved) return resolution.response;
        const { actor } = resolution;

        const result = await TaskListService.ensureDefaultList(actor.departmentId, actor.userId);
        return NextResponse.json({ success: true, data: result });
    } catch (error) {
        return failureResponse(error);
    }
}

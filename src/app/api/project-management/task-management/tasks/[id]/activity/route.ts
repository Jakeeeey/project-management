import { NextRequest, NextResponse } from "next/server";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/task-management/tasks/services/actor-service";
import {
    PermissionError,
} from "@/modules/project-management/task-management/tasks/services/permission-service";
import { loadTaskScoped } from "@/modules/project-management/task-management/tasks/services/scoping";
import { TaskActivityService } from "@/modules/project-management/task-management/tasks/services/task-activity-service";
import { TaskServiceError } from "@/modules/project-management/task-management/tasks/services/task-service";
import { TaskFieldError } from "@/modules/project-management/task-management/tasks/services/task-field-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The task-activity route — one task's change history, read-only.
 *
 * Every handler runs the department guard FIRST: `loadTaskScoped(actor, id)` returns a live row of
 * the actor's own department or `null`, and `null` is answered with 404 before anything else — an
 * absent, soft-deleted or another department's task stays indistinguishable, so an id outside the
 * actor's department is a 404 rather than a leak of its history.
 *
 * Contract:
 * - `GET ?limit=&offset=` -> 200 `{ success, data: TaskActivityEntry[], hasMore, limit, offset }` —
 *   ONE PAGE of this task's rows, newest-first (`changed_at DESC, id DESC`), department-scoped. The
 *   page size is clamped server-side (default 20, cap 100), so a caller can never ask for the whole
 *   trail; `offset` walks older rows and `hasMore` reports whether an older page remains. `data`
 *   stays the array and the other three keys are additive metadata. Rows sharing a `batch_id` were
 *   written by one logical save and share `actor_label` / `changed_at`; `old_label` / `new_label`
 *   are snapshots taken at write time and must never be re-resolved by a reader.
 *
 * There is deliberately no POST, PATCH or DELETE: `pm_task_activity` is APPEND-ONLY and its writer
 * lives inside the task mutation services. Exposing a verb here would be a second write path.
 *
 * An unavailable `pm_task_activity` collection reads as an empty history (the service's
 * `readOrEmpty`), so a deployment that has not run the audit-trail DDL still serves a task; any
 * other Directus failure is logged here and answered with the module's own message.
 */

/** The actor, or the envelope the handler must return instead: 401 without a session, 403 without a department. */
type ActorResolution =
    | { readonly resolved: true; readonly actor: ScopedActor }
    | { readonly resolved: false; readonly response: NextResponse };

function notFound(message: string): NextResponse {
    return NextResponse.json({ success: false, message }, { status: 404 });
}

/** A query value as a finite number, or `undefined` so the service applies its own default and cap. */
function toQueryNumber(raw: string | null): number | undefined {
    if (raw === null || raw.trim() === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
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
        console.error(`[task-activity ${scope}] task operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The task operation could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    if (error instanceof TaskFieldError) {
        if (error.code === "NOT_FOUND") {
            return NextResponse.json({ success: false, message: error.message }, { status: 404 });
        }
        if (error.code === "VALIDATION_FAILED") {
            return NextResponse.json({ success: false, message: error.message }, { status: 400 });
        }
        console.error(`[task-activity ${scope}] custom-column operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The custom-column operation could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[task-activity ${scope}] unexpected error:`, error);
    return NextResponse.json(
        { success: false, message: "An unexpected error occurred. Please try again later." },
        { status: 500 },
    );
}

export async function GET(
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

        const page = await TaskActivityService.listActivity(actor, id, {
            limit: toQueryNumber(req.nextUrl.searchParams.get("limit")),
            offset: toQueryNumber(req.nextUrl.searchParams.get("offset")),
        });

        return NextResponse.json({
            success: true,
            data: page.entries,
            hasMore: page.hasMore,
            limit: page.limit,
            offset: page.offset,
        });
    } catch (error) {
        return failureResponse("GET", error);
    }
}

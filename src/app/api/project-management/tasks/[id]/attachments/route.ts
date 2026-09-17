import { NextRequest, NextResponse } from "next/server";
import { isScopedActor, resolveActor, type ScopedActor } from "@/modules/project-management/services/actor-service";
import { loadAttachmentScoped, loadTaskScoped } from "@/modules/project-management/services/scoping";
import {
    ATTACHMENT_ACCEPTED_TYPES,
    AttachmentService,
    AttachmentServiceError,
    MAX_ATTACHMENT_BYTES,
} from "@/modules/project-management/tasks/services/attachment-service";
import { AttachmentDetachSchema } from "@/modules/project-management/tasks/types/attachment.schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The task-attachment route — upload one file to a task, or detach one of its attachments.
 *
 * Every handler runs the department guard FIRST: `loadTaskScoped(actor, id)` returns a live row of
 * the actor's own department or `null`, and `null` is answered with 404 before the body is even
 * read. Absent, soft-deleted and another department's tasks stay indistinguishable.
 *
 * Contract:
 * - `POST` multipart (`file`) -> 201 `{ data: <Directus file object> }`. This route is the plan's
 *   documented exception to the app envelope: success is Directus's own raw `{ data }`, which the
 *   attachment UI reads as `data.id`. Failures stay in the module envelope.
 *   Size and the declared MIME are re-checked server-side (413 / 415 — `accept` is a UX hint, not
 *   a control), and the filename / MIME / size cached on the row come from Directus's response,
 *   never from the client's declaration. The file lands in the `pm_task_attachments` folder
 *   (get-or-create by name; the folder is appended before the binary, Authorization only).
 * - `DELETE ?attachmentId=<id>` -> 200 `{ success, data: { id, task_id } }`. The attachment is
 *   loaded with `loadAttachmentScoped` — 404 on a department mismatch, a soft-deleted row, or an
 *   attachment that belongs to a different task — then soft-deleted. The Directus file is
 *   deliberately left in place: the app never hard-deletes a file.
 *
 * Directus failures are logged here with their raw body and answered with the module's own generic
 * message — raw Directus text never reaches a client, and the upload route never PATCHes an
 * uploader onto the file (attribution lives on the row's `created_by`).
 */

/** The actor, or the envelope the handler must return instead: 401 without a session, 403 without a department. */
type ActorResolution =
    | { readonly resolved: true; readonly actor: ScopedActor }
    | { readonly resolved: false; readonly response: NextResponse };

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

/** Maps a thrown error to the envelope. Raw Directus text is logged server-side, never returned. */
function failureResponse(scope: string, error: unknown): NextResponse {
    if (error instanceof AttachmentServiceError) {
        if (error.code === "UPSTREAM_FAIL") {
            return NextResponse.json({ success: false, message: error.message }, { status: 502 });
        }
        console.error(`[task-attachments ${scope}] attachment operation failed:`, error);
        return NextResponse.json(
            { success: false, message: "The attachment operation could not be completed. Please try again later." },
            { status: 500 },
        );
    }
    console.error(`[task-attachments ${scope}] unexpected error:`, error);
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

        let form: FormData;
        try {
            form = await req.formData();
        } catch {
            return badRequest("Request body must be multipart form data");
        }

        const file = form.get("file");
        if (!(file instanceof File)) return badRequest("No file provided");

        if (file.size > MAX_ATTACHMENT_BYTES) {
            return NextResponse.json(
                { success: false, message: `File too large. Maximum size is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` },
                { status: 413 },
            );
        }
        if (!ATTACHMENT_ACCEPTED_TYPES.includes(file.type)) {
            return NextResponse.json(
                { success: false, message: `Unsupported file type. Allowed: ${ATTACHMENT_ACCEPTED_TYPES.join(", ")}` },
                { status: 415 },
            );
        }

        const uploaded = await AttachmentService.attachFile(actor, task, file);

        // The documented envelope exception: Directus's own `{ data }`, not `{ success, data }`.
        return NextResponse.json({ data: uploaded }, { status: 201 });
    } catch (error) {
        return failureResponse("upload", error);
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

        const validation = AttachmentDetachSchema.safeParse({
            attachmentId: req.nextUrl.searchParams.get("attachmentId"),
        });
        if (!validation.success) {
            return NextResponse.json(
                { success: false, message: "Validation failed", errors: validation.error.flatten().fieldErrors },
                { status: 400 },
            );
        }

        const attachment = await loadAttachmentScoped(actor, validation.data.attachmentId);
        if (attachment === null || Number(attachment.task_id) !== Number(task.id)) {
            return notFound("Attachment not found");
        }

        await AttachmentService.detachAttachment(actor, attachment);

        return NextResponse.json({ success: true, data: { id: attachment.id, task_id: task.id } });
    } catch (error) {
        return failureResponse("detach", error);
    }
}

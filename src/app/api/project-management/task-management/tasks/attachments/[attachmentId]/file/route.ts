import { NextRequest, NextResponse } from "next/server";
import { isScopedActor, resolveActor } from "@/modules/project-management/task-management/tasks/services/actor-service";
import { loadAttachmentScoped } from "@/modules/project-management/task-management/tasks/services/scoping";
import { AttachmentStreamService } from "@/modules/project-management/task-management/tasks/services/attachment-stream-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The attachment streaming proxy — the only URL the browser ever sees for a file's bytes.
 *
 * The raw `/assets/<uuid>` route is never exposed: it needs the static token, which only this
 * server-side hop holds. Contract:
 * 1. `resolveActor()` — 401 without a session, 403 without a department.
 * 2. `loadAttachmentScoped(actor, attachmentId)` — **404, never 403**, on a department mismatch or
 *    a soft-deleted row. Not a single byte is fetched before this check.
 * 3. File metadata is read back from Directus (`cache: "no-store"`) for the friendly filename and
 *    correct MIME; a failed metadata read falls back to the row's cached columns.
 * 4. The incoming `Range` header is forwarded upstream and the upstream status is propagated — a
 *    ranged request answers 206 with `Content-Range`, so PDF seeking works instead of being
 *    silently downgraded to a full 200 body.
 * 5. The body streams straight through (`new Response(upstream.body, ...)`, zero buffering) with
 *    `Content-Disposition: <inline|attachment>` — `?download=1` switches to attachment — and
 *    `Cache-Control: private, no-store` because the bytes are per-user and replaceable.
 */

/** Upstream headers that must survive the hop for range requests to work. */
const PASSTHROUGH_HEADERS = ["content-range", "content-length", "accept-ranges"] as const;

function jsonError(message: string, status: number): NextResponse {
    return NextResponse.json({ success: false, message }, { status });
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
    try {
        const { attachmentId } = await params;

        const actor = await resolveActor();
        if (actor === null) return jsonError("Unauthorized", 401);
        if (!isScopedActor(actor)) return jsonError("Forbidden: your account is not assigned to a department", 403);

        const attachment = await loadAttachmentScoped(actor, attachmentId);
        if (attachment === null) return jsonError("Attachment not found", 404);

        const metadata = await AttachmentStreamService.readFileMetadata(attachment.file_id);
        const filename = metadata?.filename ?? attachment.file_name ?? `attachment-${attachment.id}`;
        const contentType = metadata?.type ?? attachment.file_type ?? "application/octet-stream";

        const upstream = await AttachmentStreamService.requestFileContent(attachment.file_id, req.headers.get("range"));
        if (upstream === null || (!upstream.ok && upstream.status !== 416)) {
            console.error(
                `[task-attachments stream] the Directus asset read failed with status ${upstream?.status ?? "network error"}`,
            );
            return jsonError("The file could not be retrieved. Please try again later.", 502);
        }

        const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
        const headers = new Headers({
            "Content-Type": contentType,
            "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "Cache-Control": "private, no-store",
        });
        for (const name of PASSTHROUGH_HEADERS) {
            const value = upstream.headers.get(name);
            if (value !== null) headers.set(name, value);
        }

        return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
        console.error("[task-attachments stream] unexpected error:", error);
        return jsonError("An unexpected error occurred. Please try again later.", 500);
    }
}

import { getDirectusBaseUrl } from "./directus-client";

/**
 * The attachment egress service — everything the streaming proxy needs from Directus.
 *
 * This is plumbing on purpose: no auth decision and no department scoping live here. The route
 * runs `loadAttachmentScoped` before calling in, so a file is only ever named after its
 * `pm_task_attachment` row was proven to belong to the actor's own department.
 */

/** The Directus file metadata the stream route renders: friendly filename and correct MIME. */
export interface AttachmentFileMetadata {
    readonly filename: string | null;
    readonly type: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AttachmentStreamService {
    /**
     * Reads `/files/<uuid>` for a friendly `Content-Disposition` filename and the correct MIME.
     * `cache: "no-store"` because Directus is the source of truth — a replaced file must never be
     * served from a stale cache. A miss answers `null`, and the route falls back to the row's
     * cached `file_name` / `file_type` instead of failing the stream.
     */
    static async readFileMetadata(fileId: string): Promise<AttachmentFileMetadata | null> {
        const url = `${getDirectusBaseUrl()}/files/${encodeURIComponent(fileId)}?fields=filename_download,type`;
        try {
            const response = await fetch(url, {
                headers: { Authorization: `Bearer ${process.env.DIRECTUS_STATIC_TOKEN ?? ""}` },
                cache: "no-store",
            });
            if (!response.ok) {
                console.warn(`[task-attachments stream] the file metadata read failed with status ${response.status}`);
                return null;
            }
            const payload: unknown = await response.json();
            const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
            if (data === null) return null;
            return {
                filename: typeof data.filename_download === "string" ? data.filename_download : null,
                type: typeof data.type === "string" ? data.type : null,
            };
        } catch (error) {
            console.warn("[task-attachments stream] the file metadata read errored:", error);
            return null;
        }
    }

    /**
     * Fetches the binary through Directus's `/assets/<uuid>`, forwarding the caller's `Range`
     * header verbatim so Directus can answer 206 with `Content-Range` — the point of this proxy
     * for PDF seeking, and exactly what the canonical template omits.
     *
     * @returns The upstream response untouched (status, headers and body), or `null` on a
     *          transport failure, which the route answers with 502.
     */
    static async requestFileContent(fileId: string, range: string | null): Promise<Response | null> {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${process.env.DIRECTUS_STATIC_TOKEN ?? ""}`,
        };
        if (range !== null) headers.Range = range;

        try {
            return await fetch(`${getDirectusBaseUrl()}/assets/${encodeURIComponent(fileId)}`, {
                headers,
                cache: "no-store",
            });
        } catch (error) {
            console.error("[task-attachments stream] the Directus asset request failed:", error);
            return null;
        }
    }
}

import { DirectusRequestError, createItem, getDirectusBaseUrl, updateItem } from "./directus-client";
import type { ScopedActor } from "./actor-service";
import type { ScopedAttachmentRow, ScopedTaskRow } from "./scoping";
import { phNow } from "../utils/ph-time";

/**
 * The attachment ingest service — the Directus file's folder, the multipart upload, and the
 * `pm_task_attachment` row that links the file uuid to a task.
 *
 * The route has already run the department guard (`loadTaskScoped`), so every method here receives
 * a live task row of the actor's own department.
 *
 * The upstream call follows the canonical pipeline (`data_file_Upload.md` section 6): the folder is
 * resolved by NAME and created on a miss, `folder` is appended BEFORE the binary, the file is
 * appended with no third argument, and the `/files` POST carries `Authorization` only — a manual
 * `Content-Type` would clobber the generated multipart boundary.
 *
 * Two documented policies are enforced here rather than left to a caller:
 * - the filename/MIME/size cached on the row come from Directus's own response, never from the
 *   client's declaration — the declared `file.type` only ever decides acceptance, in the route;
 * - detaching soft-deletes the row and deliberately leaves the Directus file in place. The app
 *   never hard-deletes a file, so an upload whose row insert fails is an orphan by policy.
 */

/** The one folder every task attachment is filed under — per business domain, never per user. */
export const ATTACHMENT_FOLDER_NAME = "pm_task_attachments";

/** The canonical 5 MB ceiling; a larger file is answered with 413 before any Directus call. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * The accepted upload types. The first five render inline (images and PDF); the rest are stored
 * and served as downloads. Script-bearing types (`text/html`, `image/svg+xml`) are deliberately
 * absent — inline preview of uploaded markup is an XSS vector.
 */
export const ATTACHMENT_ACCEPTED_TYPES: readonly string[] = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/zip",
];

/** The coded failure kinds this service throws. The route maps them to 502 / 500. */
export type AttachmentServiceErrorCode = "UPSTREAM_FAIL" | "INTERNAL_FAIL";

/** An attachment refusal, carrying the `CODE: message` shape conventions section 13 pins. */
export class AttachmentServiceError extends Error {
    readonly code: AttachmentServiceErrorCode;

    constructor(code: AttachmentServiceErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "AttachmentServiceError";
        this.code = code;
    }
}

/** The Directus file object the `/files` upload returns; only the fields the module reads are named. */
export type UploadedFile = Readonly<Record<string, unknown>> & { readonly id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** `Number(null)` is `0`, so nullish is checked before conversion. */
function readSize(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const size = Number(value);
    return Number.isFinite(size) && size >= 0 ? size : null;
}

/** Logs a Directus refusal with its raw body server-side; the body never reaches a client. */
function logDirectusFailure(prefix: string, error: unknown): void {
    if (error instanceof DirectusRequestError) {
        console.error(`${prefix} status ${error.status}:`, error.body ?? "");
        return;
    }
    console.error(prefix, error);
}

/** The Directus origin plus the static token, read per call so env edits need no reload. */
function directusConnection(): { readonly base: string; readonly token: string } {
    return { base: getDirectusBaseUrl(), token: process.env.DIRECTUS_STATIC_TOKEN ?? "" };
}

export class AttachmentService {
    /**
     * Uploads the bytes to Directus and links them to the task with a `pm_task_attachment` row
     * carrying the bare file uuid plus the filename / MIME / size Directus reported.
     *
     * `department_id`, `created_by`, `updated_by` and both timestamps are injected from the actor
     * and `phNow()` — nothing about the row comes from the client.
     *
     * @returns Directus's own file object, which the route returns verbatim as `{ data }`.
     */
    static async attachFile(actor: ScopedActor, task: ScopedTaskRow, file: File): Promise<UploadedFile> {
        const uploaded = await AttachmentService.uploadFile(file);

        const now = phNow();
        try {
            await createItem<unknown>("pm_task_attachment", {
                task_id: task.id,
                department_id: actor.departmentId,
                file_id: uploaded.id,
                file_name: readText(uploaded.filename_download),
                file_type: readText(uploaded.type),
                file_size: readSize(uploaded.filesize),
                is_deleted: 0,
                created_at: now,
                created_by: actor.userId,
                updated_at: now,
                updated_by: actor.userId,
            });
        } catch (error) {
            // The bytes are stored but the row is not. The app never hard-deletes a Directus file,
            // so this one is deliberately orphaned and the failure is reported, never hidden.
            logDirectusFailure("[task-attachments upload] Directus rejected the attachment row:", error);
            throw new AttachmentServiceError(
                "INTERNAL_FAIL",
                "The file was uploaded but could not be attached to the task. Please try again.",
            );
        }

        return uploaded;
    }

    /**
     * Soft-deletes one attachment row — never a hard delete, and never a Directus `/files` DELETE.
     * The file stays in Directus on purpose (the plan's documented orphan policy); only the link
     * between the file and the task disappears.
     */
    static async detachAttachment(actor: ScopedActor, attachment: ScopedAttachmentRow): Promise<void> {
        await updateItem<unknown>("pm_task_attachment", attachment.id, {
            is_deleted: 1,
            updated_at: phNow(),
            updated_by: actor.userId,
        });
    }

    /**
     * POSTs the binary to Directus's `/files`.
     *
     * The `FormData` is a FRESH one: metadata (`folder`) first, the binary last, and the binary
     * appended with no third argument so Directus derives the stored filename itself.
     */
    private static async uploadFile(file: File): Promise<UploadedFile> {
        const { base, token } = directusConnection();
        const folderId = await AttachmentService.resolveFolderId(base, token);

        const outgoing = new FormData();
        if (folderId !== null) outgoing.append("folder", folderId);
        outgoing.append("file", file);

        let response: Response;
        try {
            response = await fetch(`${base}/files`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` }, // Authorization ONLY — fetch owns the boundary
                body: outgoing,
            });
        } catch (error) {
            console.error("[task-attachments upload] the Directus /files request failed:", error);
            throw new AttachmentServiceError("UPSTREAM_FAIL", "The file could not be uploaded. Please try again.");
        }

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.error(`[task-attachments upload] Directus rejected the upload with status ${response.status}:`, body);
            throw new AttachmentServiceError("UPSTREAM_FAIL", "The file could not be uploaded. Please try again.");
        }

        const payload: unknown = await response.json().catch(() => null);
        const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
        const id = data === null ? null : data.id;
        if (data === null || typeof id !== "string") {
            console.error("[task-attachments upload] Directus returned no file id:", payload);
            throw new AttachmentServiceError("UPSTREAM_FAIL", "The file could not be uploaded. Please try again.");
        }
        return Object.assign({}, data, { id });
    }

    /** Look the folder up by name; create it on a miss. Either step may answer `null` (fail open). */
    private static async resolveFolderId(base: string, token: string): Promise<string | null> {
        const existing = await AttachmentService.lookupFolderId(base, token);
        if (existing !== null) return existing;
        return AttachmentService.createFolderId(base, token);
    }

    /**
     * The name is URL-encoded (it is a string, not a number) and never a hardcoded uuid — folder
     * ids differ per environment.
     */
    private static async lookupFolderId(base: string, token: string): Promise<string | null> {
        const url = `${base}/folders?filter[name][_eq]=${encodeURIComponent(ATTACHMENT_FOLDER_NAME)}&fields=id`;
        try {
            const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
            if (!response.ok) {
                console.warn(`[task-attachments upload] the folder lookup failed with status ${response.status}`);
                return null;
            }
            const payload: unknown = await response.json();
            const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
            const first: unknown = rows[0];
            return isRecord(first) && typeof first.id === "string" ? first.id : null;
        } catch (error) {
            console.warn("[task-attachments upload] the folder lookup errored:", error);
            return null;
        }
    }

    /**
     * Fail open: when the folder cannot be created the upload still proceeds with no `folder`
     * field, so the file lands at the Directus root instead of the user's upload failing over an
     * organizational detail.
     */
    private static async createFolderId(base: string, token: string): Promise<string | null> {
        try {
            const response = await fetch(`${base}/folders`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ name: ATTACHMENT_FOLDER_NAME }),
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                console.warn(`[task-attachments upload] folder creation failed with status ${response.status}:`, body);
                return null;
            }
            const payload: unknown = await response.json();
            const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
            return data !== null && typeof data.id === "string" ? data.id : null;
        } catch (error) {
            console.warn("[task-attachments upload] folder creation errored; uploading without a folder:", error);
            return null;
        }
    }
}

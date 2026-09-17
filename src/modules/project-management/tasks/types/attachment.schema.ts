import { z } from "zod";

/**
 * Attachment contracts for the tasks module.
 *
 * A `pm_task_attachment` row points at a Directus file by uuid; the binary never travels through
 * these schemas — uploads are multipart and downloads stream from the module's own proxy route, so
 * size and MIME policy live with the route that enforces them.
 *
 * `is_deleted` is deliberately not modelled: every query filters it out, and Directus can return
 * that tinyint as a number, a string or a boolean — normalizing that shape belongs to the service
 * that reads it, not to this contract.
 */

/** `pm_task_attachment.file_id` — the Directus file uuid (`CHAR(36)` in MySQL). */
export const FileIdSchema = z.uuid();

/** An attachment row as the API hands it to the module's UI. */
export const AttachmentSchema = z.object({
    id: z.number().int().positive(),
    task_id: z.number().int().positive(),
    file_id: FileIdSchema,
    file_name: z.string().nullable(),
    file_type: z.string().nullable(),
    file_size: z.number().int().nonnegative().nullable(),
    sort_order: z.number().int(),
});

/**
 * Query payload for detaching: `DELETE /tasks/[id]/attachments?attachmentId=<id>`.
 * Query values arrive as strings, hence the coercion.
 */
export const AttachmentDetachSchema = z.object({
    attachmentId: z.coerce.number().int().positive(),
});

export type Attachment = z.infer<typeof AttachmentSchema>;
export type AttachmentDetachInput = z.infer<typeof AttachmentDetachSchema>;

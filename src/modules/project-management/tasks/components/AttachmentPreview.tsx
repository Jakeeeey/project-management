"use client";

import { Download, FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { TaskAttachmentRef } from "../hooks/useTasks";

/**
 * The inline preview surface for one attachment.
 *
 * The browser is only ever handed the module's OWN stream route — never Directus's raw
 * `/assets/<uuid>`, which needs the server-only static token and would 401 from the browser. Every
 * `viewUrl` below is built from the attachment's row id, so it stays stable across a file replace
 * (the plan's "viewUrl is the stream route" rule; `data_file_Upload.md` sections 11 and 19.10).
 *
 * Three behaviours, chosen from the stored MIME type alone:
 * - `image/*` renders an `<img>` (safe even for an SVG, which cannot script when embedded this way).
 * - `application/pdf` renders an `<iframe>`; the stream route forwards `Range`, so the browser's
 *   viewer can page and seek.
 * - anything else is download-only: no `<img>`, no `<iframe>`, just an explicit affordance. An
 *   inline preview is never attempted for a type the browser cannot render.
 *
 * The type is DATA, read off the row. Nothing here maps an extension to a viewer, and an absent
 * type degrades to the download-only branch rather than guessing.
 */

/** The stream route that proxies one attachment's bytes: the only URL the browser is given. */
export function attachmentViewUrl(attachmentId: number): string {
    return `/api/project-management/tasks/attachments/${attachmentId}/file`;
}

/** The same route with `?download=1`, which flips `Content-Disposition` to `attachment`. */
export function attachmentDownloadUrl(attachmentId: number): string {
    return `${attachmentViewUrl(attachmentId)}?download=1`;
}

/** The three preview behaviours a stored MIME type can resolve to. */
export type AttachmentPreviewKind = "image" | "pdf" | "other";

/** Classifies a stored MIME type. Anything unknown is deliberately the download-only branch. */
export function attachmentPreviewKind(fileType: string | null | undefined): AttachmentPreviewKind {
    const type = typeof fileType === "string" ? fileType.trim().toLowerCase() : "";
    if (type.startsWith("image/")) return "image";
    if (type === "application/pdf") return "pdf";
    return "other";
}

/** The row's stored filename, or a stable fallback derived from the row id. */
export function attachmentDisplayName(attachment: TaskAttachmentRef): string {
    const name = attachment.file_name?.trim();
    return name !== undefined && name !== "" ? name : `Attachment #${attachment.id}`;
}

/** Shared framed box for a rendered preview. */
const PREVIEW_FRAME_CLASS = "w-full rounded-md border border-border/60 bg-muted/30";

export interface AttachmentPreviewProps {
    readonly attachment: TaskAttachmentRef;
    /** Runs the Blob download owned by the list; this component never fetches the bytes itself. */
    readonly onDownload: (attachment: TaskAttachmentRef) => void;
    /** True while this attachment's download is in flight — gates the download-only affordance. */
    readonly isDownloading?: boolean;
    readonly className?: string;
}

export function AttachmentPreview({
    attachment,
    onDownload,
    isDownloading = false,
    className,
}: AttachmentPreviewProps) {
    const kind = attachmentPreviewKind(attachment.file_type);
    const name = attachmentDisplayName(attachment);
    const viewUrl = attachmentViewUrl(attachment.id);

    if (kind === "image") {
        return (
            <div data-slot="attachment-preview" data-preview-kind="image" className={cn("space-y-1", className)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={viewUrl}
                    alt={`Inline preview of ${name}`}
                    loading="lazy"
                    className={cn(PREVIEW_FRAME_CLASS, "max-h-72 object-contain")}
                />
                <p className="text-xs text-muted-foreground">Inline preview of {name}.</p>
            </div>
        );
    }

    if (kind === "pdf") {
        return (
            <div data-slot="attachment-preview" data-preview-kind="pdf" className={cn("space-y-1", className)}>
                <iframe
                    src={viewUrl}
                    title={`Inline preview of ${name}`}
                    className={cn(PREVIEW_FRAME_CLASS, "h-72")}
                />
                <p className="text-xs text-muted-foreground">
                    If the preview does not load, use Download.
                </p>
            </div>
        );
    }

    return (
        <div
            data-slot="attachment-preview"
            data-preview-kind="other"
            className={cn(
                "flex flex-col items-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/20 px-4 py-6 text-center",
                className,
            )}
        >
            <FileText className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
                This file type cannot be previewed here. Download it to open it.
            </p>
            <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onDownload(attachment)}
                disabled={isDownloading}
                aria-label={`Download ${name}`}
                title={`Download ${name}`}
                data-slot="attachment-preview-download"
                className="min-h-11 md:min-h-0"
            >
                {isDownloading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                    <Download className="size-4" aria-hidden="true" />
                )}
                Download
            </Button>
        </div>
    );
}

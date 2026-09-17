"use client";

import { useCallback, useMemo, useState } from "react";
import { Download, Eye, EyeOff, FileText, Loader2, Trash2 } from "lucide-react";

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

import type { TaskAttachmentRef } from "../hooks/useTasks";
import {
    attachmentDisplayName,
    attachmentDownloadUrl,
} from "./AttachmentPreview";
import { AttachmentPreviewDialog } from "./AttachmentPreviewDialog";

/**
 * The attachment list for one task: the rows, the centered preview modal, the Blob download and the
 * detach action.
 *
 * Data comes from the task row, not a request of its own: the list route already resolves each
 * live attachment (`{ id, file_id, file_name, file_type, file_size, sort_order }`) and strips
 * soft-deleted ones, so this component never fetches the list. Detaching goes through the module's
 * `DELETE .../attachments?attachmentId=` route via the `onDetach` callback, which refetches the
 * task list (the module's single mutation strategy) — nothing here patches optimistically.
 *
 * The download deliberately routes around the anchor's native navigation: the bytes are fetched as
 * a Blob, saved through a synthetic anchor click, and the object URL is revoked in a `finally` so a
 * download can never leak one blob (`data_file_Upload.md` section 14). Every URL the browser sees
 * is the module's own stream route — `/assets/<uuid>` is never linked.
 *
 * Two surfaces are persistent rather than toast-only: a client-side download failure renders inline
 * with `role="alert"`, and a detach failure stays in the hook's shared error state (and the toast).
 */

/** `12.4 KB`-style size text; a missing or negative size reads as "Unknown size" rather than `NaN`. */
function formatFileSize(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "Unknown size";
    if (bytes < 1024) return `${Math.round(bytes)} B`;

    const units = ["KB", "MB", "GB", "TB"] as const;
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${units[unitIndex]}`;
}

export interface AttachmentListProps {
    readonly taskId: number;
    /** The task row's live attachments (`sort_order, id` order is re-applied here). */
    readonly attachments: readonly TaskAttachmentRef[];
    /**
     * Soft-deletes one attachment link through the module route. Resolves `false` when the write
     * failed, in which case the confirm dialog stays open so the user can retry.
     */
    readonly onDetach: (taskId: number, attachmentId: number, label: string) => Promise<boolean>;
    /** True while any task write is in flight — gates every control in the list. */
    readonly disabled?: boolean;
}

export function AttachmentList({ taskId, attachments, onDetach, disabled = false }: AttachmentListProps) {
    /**
     * The row whose preview modal is open, held whole rather than by id: a refetch of the task list
     * rebuilds the attachment objects, and keeping the row itself means the modal cannot close or
     * orphan mid-view. Only one preview is open at a time.
     */
    const [previewAttachment, setPreviewAttachment] = useState<TaskAttachmentRef | null>(null);
    /** The row whose Blob download is in flight — drives the spinner, never blocks the others. */
    const [downloadingId, setDownloadingId] = useState<number | null>(null);
    /** The row awaiting detach confirmation. */
    const [pendingDetach, setPendingDetach] = useState<TaskAttachmentRef | null>(null);
    const [isDetaching, setIsDetaching] = useState(false);
    /** Download failures only — detach failures surface through the surrounding hook. */
    const [error, setError] = useState<string | null>(null);

    const ordered = useMemo(
        () =>
            [...attachments].sort(
                (left, right) => left.sort_order - right.sort_order || left.id - right.id,
            ),
        [attachments],
    );

    /** Blob download: fetch the stream route, save via a synthetic anchor, always revoke the URL. */
    const handleDownload = useCallback(async (attachment: TaskAttachmentRef): Promise<void> => {
        setError(null);
        setDownloadingId(attachment.id);
        try {
            const res = await fetch(attachmentDownloadUrl(attachment.id), { cache: "no-store" });
            if (!res.ok) throw new Error("The file could not be downloaded. Please try again.");

            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            try {
                const anchor = document.createElement("a");
                anchor.href = objectUrl;
                anchor.download = attachmentDisplayName(attachment);
                anchor.rel = "noopener";
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "The file could not be downloaded.");
        } finally {
            setDownloadingId(null);
        }
    }, []);

    const handleConfirmDetach = useCallback(async (): Promise<void> => {
        if (pendingDetach === null) return;

        setIsDetaching(true);
        try {
            const detached = await onDetach(taskId, pendingDetach.id, attachmentDisplayName(pendingDetach));
            if (!detached) return;
            setPreviewAttachment((current) => (current?.id === pendingDetach.id ? null : current));
            setPendingDetach(null);
        } finally {
            setIsDetaching(false);
        }
    }, [pendingDetach, onDetach, taskId]);

    const pendingDetachName = pendingDetach === null ? "This file" : attachmentDisplayName(pendingDetach);

    return (
        <div data-slot="attachment-list" className="space-y-2">
            {error !== null ? (
                <p role="alert" data-slot="attachment-list-error" className="text-xs text-destructive">
                    {error}
                </p>
            ) : null}

            {ordered.length === 0 ? (
                <p data-slot="attachment-list-empty" className="text-sm text-muted-foreground">
                    No files attached yet.
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {ordered.map((attachment) => {
                        const name = attachmentDisplayName(attachment);
                        const typeLabel = attachment.file_type?.trim() || "Unknown type";
                        const isOpen = previewAttachment?.id === attachment.id;
                        const isDownloading = downloadingId === attachment.id;

                        return (
                            <li
                                key={attachment.id}
                                data-slot="attachment-item"
                                data-attachment-id={attachment.id}
                                className="rounded-lg border border-border/50 bg-muted/20"
                            >
                                <div className="flex items-center gap-2 px-3 py-2">
                                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />

                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium" title={name}>
                                            {name}
                                        </p>
                                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                                            <span className="max-w-[180px] truncate" title={typeLabel}>
                                                {typeLabel}
                                            </span>
                                            <span aria-hidden="true">·</span>
                                            <span className="tabular-nums">
                                                {formatFileSize(attachment.file_size)}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex shrink-0 items-center gap-0.5">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`${isOpen ? "Hide preview of" : "Show preview of"} ${name}`}
                                            title={`${isOpen ? "Hide preview of" : "Show preview of"} ${name}`}
                                            aria-expanded={isOpen}
                                            data-slot="attachment-toggle-preview"
                                            onClick={() => setPreviewAttachment(isOpen ? null : attachment)}
                                            disabled={disabled}
                                        >
                                            {isOpen ? (
                                                <EyeOff className="size-4" aria-hidden="true" />
                                            ) : (
                                                <Eye className="size-4" aria-hidden="true" />
                                            )}
                                        </Button>

                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`Download ${name}`}
                                            title={`Download ${name}`}
                                            data-slot="attachment-download"
                                            onClick={() => {
                                                void handleDownload(attachment);
                                            }}
                                            disabled={disabled || isDownloading}
                                        >
                                            {isDownloading ? (
                                                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                            ) : (
                                                <Download className="size-4" aria-hidden="true" />
                                            )}
                                        </Button>

                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`Detach ${name}`}
                                            title={`Detach ${name}`}
                                            data-slot="attachment-detach"
                                            onClick={() => setPendingDetach(attachment)}
                                            disabled={disabled}
                                        >
                                            <Trash2 className="size-4 text-destructive" aria-hidden="true" />
                                        </Button>
                                    </div>
                                </div>

                            </li>
                        );
                    })}
                </ul>
            )}

            <AlertDialog
                open={pendingDetach !== null}
                onOpenChange={(next) => {
                    if (!next) setPendingDetach(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Detach this file?</AlertDialogTitle>
                        <AlertDialogDescription>
                            &ldquo;{pendingDetachName}&rdquo; will be removed from this task. The stored file is
                            deliberately kept and is not deleted from storage.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isDetaching}>Cancel</AlertDialogCancel>
                        <Button
                            type="button"
                            variant="destructive"
                            disabled={isDetaching}
                            data-slot="attachment-detach-confirm"
                            onClick={(event) => {
                                event.preventDefault();
                                void handleConfirmDetach();
                            }}
                            className="min-h-11 md:min-h-0"
                        >
                            {isDetaching ? (
                                <>
                                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                    Detaching…
                                </>
                            ) : (
                                <>
                                    <Trash2 className="size-4" aria-hidden="true" />
                                    Detach file
                                </>
                            )}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AttachmentPreviewDialog
                attachment={previewAttachment}
                onOpenChange={(next) => {
                    if (!next) setPreviewAttachment(null);
                }}
                onDownload={(target) => {
                    void handleDownload(target);
                }}
                isDownloading={previewAttachment !== null && downloadingId === previewAttachment.id}
            />
        </div>
    );
}

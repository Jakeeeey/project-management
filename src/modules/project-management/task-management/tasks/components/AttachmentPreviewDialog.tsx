"use client";

import { Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

import type { TaskAttachmentRef } from "../hooks/useTasks";
import { AttachmentPreview, attachmentDisplayName } from "./AttachmentPreview";

/**
 * The centered modal that hosts one attachment's preview.
 *
 * It exists because the detail Sheet is only 500px wide: a preview inside it was squeezed into a
 * 288px frame, which is a poor place to read a multi-page PDF. A centered dialog at 95vw / 900px
 * gives the browser's own viewer room on a desktop and on a 375px phone alike.
 *
 * The dialog owns no data. The row being previewed is held whole by the list and passed in, so a
 * refetch or re-render of the list cannot close or orphan the modal mid-view, and the bytes still
 * come from `AttachmentPreview`'s own stream-route URL — no new fetch, Blob preview or base64.
 *
 * The only close affordance that is dialog-specific is the footer Close; the primitive's own
 * top-right X comes with `DialogContent`. Both route through Radix's `onOpenChange`, which the list
 * maps back to clearing `previewAttachment`.
 */

export interface AttachmentPreviewDialogProps {
    /** The row being previewed; `null` keeps the dialog closed. */
    readonly attachment: TaskAttachmentRef | null;
    readonly onOpenChange: (open: boolean) => void;
    /** Runs the Blob download owned by the list; the dialog never fetches the bytes itself. */
    readonly onDownload: (attachment: TaskAttachmentRef) => void;
    /** True while this attachment's download is in flight — gates the footer action. */
    readonly isDownloading?: boolean;
}

export function AttachmentPreviewDialog({
    attachment,
    onOpenChange,
    onDownload,
    isDownloading = false,
}: AttachmentPreviewDialogProps) {
    const name = attachment === null ? "" : attachmentDisplayName(attachment);
    const typeLabel = attachment?.file_type?.trim() || "Unknown type";

    return (
        <Dialog open={attachment !== null} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[85vh] w-[95vw] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[900px]">
                {attachment !== null ? (
                    <>
                        <DialogHeader className="border-b px-6 pt-6 pb-4">
                            <DialogTitle className="line-clamp-2 break-all">{name}</DialogTitle>
                            <DialogDescription>{typeLabel}</DialogDescription>
                        </DialogHeader>

                        <div
                            data-slot="attachment-preview-body"
                            className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4 sm:py-4"
                        >
                            <AttachmentPreview
                                attachment={attachment}
                                onDownload={onDownload}
                                isDownloading={isDownloading}
                            />
                        </div>

                        <DialogFooter className="border-t bg-muted/20 px-6 py-3">
                            <DialogClose asChild>
                                <Button
                                    type="button"
                                    variant="outline"
                                    data-slot="attachment-preview-close"
                                    className="min-h-11 md:min-h-0"
                                >
                                    Close
                                </Button>
                            </DialogClose>
                            <Button
                                type="button"
                                onClick={() => onDownload(attachment)}
                                disabled={isDownloading}
                                aria-label={`Download ${name}`}
                                title={`Download ${name}`}
                                data-slot="attachment-preview-download-action"
                                className="min-h-11 md:min-h-0"
                            >
                                {isDownloading ? (
                                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                ) : (
                                    <Download className="size-4" aria-hidden="true" />
                                )}
                                Download
                            </Button>
                        </DialogFooter>
                    </>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

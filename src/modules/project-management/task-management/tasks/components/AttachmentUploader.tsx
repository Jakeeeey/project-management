"use client";

import { useCallback, useId, useRef, useState, type ChangeEvent } from "react";
import { Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The attachment uploader for one task.
 *
 * It posts a single `FormData` to the module's own route
 * (`POST /api/project-management/task-management/tasks/<id>/attachments`) and — critically — sets
 * **no `Content-Type` header**: the browser must generate `multipart/form-data; boundary=...`
 * itself, and hardcoding the header clobbers that boundary (`data_file_Upload.md` section 19.1).
 * The file is appended under the `file` key the route reads.
 *
 * The server is the authority — it re-checks the 5 MB ceiling (413) and the MIME allowlist (415) —
 * so the same policy is mirrored here only as a UX hint (`accept` plus an early inline message),
 * never as a control. A rejected pick never reaches the network.
 *
 * The `uploading` flag is owned here and reset in `finally`, so the button can never stay stuck on
 * "Uploading…" after a failure, and the control is disabled for the whole in-flight window. The
 * write itself goes through the module's shared mutations hook, which refetches the task list after
 * success — nothing is patched optimistically.
 */

/**
 * The client-side mirror of the route's MIME allowlist. It exists so an obviously-wrong pick can be
 * answered without a round trip; the route remains the source of truth and re-validates every
 * upload. Script-bearing types (`text/html`, `image/svg+xml`) are deliberately absent there too.
 */
const ACCEPTED_MIME_TYPES: readonly string[] = [
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

/** What the picker offers; a hint only — the route still enforces the allowlist. */
const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(",");

/** The route's 5 MB ceiling, mirrored for the early inline rejection. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** `5 MB` / `512 KB` display text for the size limit. */
function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

export interface AttachmentUploaderProps {
    readonly taskId: number;
    /**
     * Uploads one file through the module route. Resolves `true` on success (the hook has already
     * refetched the list) and `false` on failure.
     */
    readonly onUpload: (taskId: number, file: File) => Promise<boolean>;
    /** True while any task write is in flight — gates the picker and the button. */
    readonly disabled?: boolean;
}

export function AttachmentUploader({ taskId, onUpload, disabled = false }: AttachmentUploaderProps) {
    const [file, setFile] = useState<File | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const inputId = useId();
    const hintId = `${inputId}-hint`;
    const errorId = `${inputId}-error`;

    const isDisabled = disabled || isUploading;

    const resetSelection = useCallback((): void => {
        setFile(null);
        if (inputRef.current !== null) inputRef.current.value = "";
    }, []);

    const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setError(null);
        setFile(event.target.files?.[0] ?? null);
    }, []);

    const handleUpload = useCallback(async (): Promise<void> => {
        if (file === null) return;
        setError(null);

        if (file.size > MAX_ATTACHMENT_BYTES) {
            setError(`“${file.name}” is larger than the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`);
            return;
        }
        if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
            setError(
                `“${file.name}” has a file type that is not accepted. Use an image, PDF, or a common office, text or zip file.`,
            );
            return;
        }

        setIsUploading(true);
        try {
            const uploaded = await onUpload(taskId, file);
            if (uploaded) resetSelection();
        } catch {
            setError("The file could not be uploaded. Please try again.");
        } finally {
            // Always released, so a failed upload can never leave the control stuck.
            setIsUploading(false);
        }
    }, [file, onUpload, taskId, resetSelection]);

    return (
        <div
            data-slot="attachment-uploader"
            className="space-y-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
        >
            <Label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
                Add a file
            </Label>

            <Input
                ref={inputRef}
                id={inputId}
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                onChange={handleFileChange}
                disabled={isDisabled}
                aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
                aria-invalid={error !== null}
            />

            <div className="flex items-center justify-between gap-2">
                <Button
                    type="button"
                    onClick={() => {
                        void handleUpload();
                    }}
                    disabled={file === null || isDisabled}
                    data-slot="attachment-upload"
                    className="min-h-11 md:min-h-0"
                >
                    {isUploading ? (
                        <>
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            Uploading…
                        </>
                    ) : (
                        <>
                            <Upload className="size-4" aria-hidden="true" />
                            Upload
                        </>
                    )}
                </Button>

                {file !== null ? (
                    <span
                        className="min-w-0 max-w-[180px] truncate text-xs text-muted-foreground"
                        title={file.name}
                    >
                        {file.name}
                    </span>
                ) : null}
            </div>

            <p id={hintId} className="text-xs text-muted-foreground">
                Up to {formatBytes(MAX_ATTACHMENT_BYTES)}. Images and PDFs preview inline; other file
                types download.
            </p>

            {error !== null ? (
                <p
                    id={errorId}
                    role="alert"
                    data-slot="attachment-uploader-error"
                    className="text-xs text-destructive"
                >
                    {error}
                </p>
            ) : null}
        </div>
    );
}

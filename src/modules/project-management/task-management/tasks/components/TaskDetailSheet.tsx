"use client";

import { useMemo, useState } from "react";
import { CalendarDays, Check, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

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
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import type { Capabilities } from "@/modules/project-management/types/capabilities";

import type { TaskField, TaskListItem } from "../hooks/useTasks";
import { AssigneeStack } from "./AssigneeStack";
import { AttachmentList } from "./AttachmentList";
import { AttachmentUploader } from "./AttachmentUploader";
import { formatTaskDate, formatTaskFieldValue } from "./TaskRow";
import { TaskPriorityBadge, TaskStatusBadge } from "./TaskRowBadges";
import type { TaskBreadcrumb } from "./TaskFormDialog";

/**
 * The read view for one task, opened from a tree row.
 *
 * It is a view first and an action surface second: the whole record (breadcrumb, status, priority,
 * assignees, dates, description and the audit trail) renders without a single write, and the footer
 * carries the three actions the actor is actually allowed to take.
 *
 * Permission gating is deliberately uneven, matching the Permission Matrix:
 * - Add sub-task follows the server's coarse `capabilities.canCreate`.
 * - Edit follows the ROW's own server-computed **`can_edit`** — head, granted access, or this task's
 *   creator — never the session-level `capabilities.canEdit`, which is only the coarse answer.
 * - Delete follows the ROW's own server-computed **`can_delete`** — never a session flag and never a
 *   `created_by === currentUserId` comparison, because the server already resolved headship, the
 *   access grant and the creator exception into that one boolean.
 *
 * Assignments are NOT edited here: the assign picker lives in the form dialog behind
 * `capabilities.canAssign`, so this surface never offers an assignment a plain member cannot make.
 *
 * Audit timestamps render the stored Philippine-time strings verbatim. They are never fed through
 * `new Date(...)`, which would re-interpret a wall-clock `YYYY-MM-DD HH:mm:ss` and shift the day.
 */

/** Shown where the directory cannot name an audit id. */
function displayName(userId: number | null, names: ReadonlyMap<number, string>): string {
    if (userId === null) return "Unknown";
    return names.get(userId) ?? `User #${userId}`;
}

/**
 * A stored audit timestamp as display text.
 *
 * The column holds Philippine wall-clock `YYYY-MM-DD HH:mm:ss`; Directus serialises it back with a
 * `T` separator. The string is only reshaped — never parsed into a `Date`, which would re-read a
 * naive stamp in the browser's zone and could shift the day.
 */
function formatAuditStamp(value: string | null): string {
    if (value === null || value.trim() === "") return "—";
    return value.replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, "");
}

export interface TaskDetailSheetProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    /** The row being viewed; `null` renders nothing (the parent keeps the id stable across refetches). */
    readonly task: TaskListItem | null;
    /** The chain from the root down to this task's parent, root-first. */
    readonly parentTrail: readonly TaskBreadcrumb[];
    /** How many direct children this task has, shown next to the Add sub-task action. */
    readonly childCount: number;
    readonly memberNameById: ReadonlyMap<number, string>;
    /** The department's custom columns, rendered with this task's answer for each. */
    readonly fields: readonly TaskField[];
    readonly capabilities: Capabilities | null;
    /** True while any task write (save or delete) is in flight — gates every footer action. */
    readonly isSubmitting: boolean;
    readonly onEdit: () => void;
    readonly onAddSubtask: () => void;
    /** Soft-deletes this task and its subtree; resolves `false` when the write failed. */
    readonly onDelete: (task: TaskListItem) => Promise<boolean>;
    /** Uploads one attachment through the module route (multipart; the hook sets no Content-Type). */
    readonly onUploadAttachment: (taskId: number, file: File) => Promise<boolean>;
    /** Detaches one attachment link through the module route; the Directus file is kept. */
    readonly onDetachAttachment: (taskId: number, attachmentId: number, label: string) => Promise<boolean>;
}

export function TaskDetailSheet({
    open,
    onOpenChange,
    task,
    parentTrail,
    childCount,
    memberNameById,
    fields,
    capabilities,
    isSubmitting,
    onEdit,
    onAddSubtask,
    onDelete,
    onUploadAttachment,
    onDetachAttachment,
}: TaskDetailSheetProps) {
    const [confirmOpen, setConfirmOpen] = useState(false);

    const assignees = useMemo(
        () =>
            (task?.assignees ?? []).map((assignee) => ({
                user_id: assignee.user_id,
                full_name: displayName(assignee.user_id, memberNameById),
            })),
        [task, memberNameById],
    );

    const canCreate = capabilities?.canCreate === true;
    const canEdit = task?.can_edit === true;
    const canDelete = task?.can_delete === true;

    const handleDelete = async (): Promise<void> => {
        if (task === null) return;
        const deleted = await onDelete(task);
        if (deleted) {
            setConfirmOpen(false);
            onOpenChange(false);
        }
    };

    const handleOpenChange = (next: boolean): void => {
        if (!next) setConfirmOpen(false);
        onOpenChange(next);
    };

    return (
        <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetContent
                side="right"
                className="flex w-full flex-col gap-0 p-0 sm:max-w-[500px]"
            >
                <SheetHeader className="border-b px-6 pt-6 pb-4">
                    <SheetTitle className="line-clamp-2">
                        {task?.title ?? "Task"}
                    </SheetTitle>
                    <SheetDescription>
                        {childCount > 0
                            ? `${childCount} direct sub-task${childCount === 1 ? "" : "s"}.`
                            : "No sub-tasks yet."}
                    </SheetDescription>
                </SheetHeader>

                {task === null ? (
                    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                        <p className="text-sm text-muted-foreground">This task is no longer available.</p>
                    </div>
                ) : (
                    <>
                        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
                            <div className="space-y-1">
                                <p className="text-xs font-medium text-muted-foreground">Parent</p>
                                <div
                                    data-slot="task-detail-parent-breadcrumb"
                                    className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm"
                                >
                                    {parentTrail.length === 0 ? (
                                        <span className="text-muted-foreground">Top-level task</span>
                                    ) : (
                                        parentTrail.map((ancestor, index) => (
                                            <span key={ancestor.id} className="flex min-w-0 items-center gap-1">
                                                {index > 0 ? (
                                                    <span className="text-muted-foreground" aria-hidden="true">
                                                        ›
                                                    </span>
                                                ) : null}
                                                <span className="max-w-[220px] truncate" title={ancestor.title}>
                                                    {ancestor.title}
                                                </span>
                                            </span>
                                        ))
                                    )}
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                <TaskStatusBadge status={task.status} />
                                <TaskPriorityBadge priority={task.priority} />
                            </div>

                            <div className="grid gap-3 sm:grid-cols-2">
                                <div
                                    data-slot="task-detail-dates"
                                    className="space-y-1 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
                                >
                                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                        <CalendarDays className="size-3.5" aria-hidden="true" />
                                        Schedule
                                    </p>
                                    <p className="text-sm">
                                        {formatTaskDate(task.start_date)}
                                        <span className="mx-1 text-muted-foreground" aria-hidden="true">
                                            →
                                        </span>
                                        {formatTaskDate(task.end_date)}
                                    </p>
                                </div>

                                <div
                                    data-slot="task-detail-assignees"
                                    className="space-y-1 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
                                >
                                    <p className="text-xs font-medium text-muted-foreground">Assignees</p>
                                    <AssigneeStack assignees={assignees} />
                                </div>
                            </div>

                            <div className="space-y-1">
                                <p className="text-xs font-medium text-muted-foreground">Description</p>
                                {task.description === null ? (
                                    <p className="text-sm text-muted-foreground">No description.</p>
                                ) : (
                                    <p className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words text-sm">
                                        {task.description}
                                    </p>
                                )}
                            </div>

                            {fields.length > 0 ? (
                                <div data-slot="task-detail-custom-fields" className="space-y-2">
                                    <p className="text-xs font-medium text-muted-foreground">Custom fields</p>
                                    <dl className="grid gap-2 sm:grid-cols-2">
                                        {fields.map((field) => {
                                            const answer =
                                                task.custom_values.find((entry) => entry.field_id === field.id)
                                                    ?.value ?? null;
                                            return (
                                                <div
                                                    key={field.id}
                                                    className="space-y-0.5 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
                                                >
                                                    <dt className="text-xs font-medium text-muted-foreground">
                                                        {field.label}
                                                    </dt>
                                                    <dd className="break-words text-sm">
                                                        {formatTaskFieldValue(field, answer)}
                                                    </dd>
                                                </div>
                                            );
                                        })}
                                    </dl>
                                </div>
                            ) : null}

                            <div data-slot="task-detail-attachments" className="space-y-2">
                                <p className="text-xs font-medium text-muted-foreground">Attachments</p>
                                <AttachmentUploader
                                    taskId={task.id}
                                    onUpload={onUploadAttachment}
                                    disabled={isSubmitting}
                                />
                                <AttachmentList
                                    taskId={task.id}
                                    attachments={task.attachments}
                                    onDetach={onDetachAttachment}
                                    disabled={isSubmitting}
                                />
                            </div>
                        </div>

                        <div
                            data-slot="task-detail-audit"
                            className="space-y-1 border-t px-6 py-4 text-xs text-muted-foreground"
                        >
                            <p data-slot="task-detail-created">
                                Created {formatAuditStamp(task.created_at)} by{" "}
                                {displayName(task.created_by, memberNameById)}
                            </p>
                            <p data-slot="task-detail-updated">
                                Last updated {formatAuditStamp(task.updated_at)} by{" "}
                                {displayName(task.updated_by, memberNameById)}
                            </p>
                        </div>

                        <SheetFooter className="mt-0 flex-wrap gap-2 border-t bg-muted/20 px-6 py-4 sm:flex-row sm:justify-end">
                            {canDelete ? (
                                <Button
                                    type="button"
                                    variant="destructive"
                                    onClick={() => setConfirmOpen(true)}
                                    disabled={isSubmitting}
                                    data-slot="task-detail-delete"
                                    className="min-h-11 sm:mr-auto md:min-h-0"
                                >
                                    <Trash2 className="size-4" aria-hidden="true" />
                                    Delete
                                </Button>
                            ) : null}

                            {canCreate ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={onAddSubtask}
                                    disabled={isSubmitting}
                                    data-slot="task-detail-add-subtask"
                                    className="min-h-11 md:min-h-0"
                                >
                                    <Plus className="size-4" aria-hidden="true" />
                                    Add sub-task
                                </Button>
                            ) : null}

                            {canEdit ? (
                                <Button
                                    type="button"
                                    onClick={onEdit}
                                    disabled={isSubmitting}
                                    data-slot="task-detail-edit"
                                    className="min-h-11 md:min-h-0"
                                >
                                    <Pencil className="size-4" aria-hidden="true" />
                                    Edit
                                </Button>
                            ) : null}
                        </SheetFooter>
                    </>
                )}

                <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
                            <AlertDialogDescription>
                                &ldquo;{task?.title ?? "This task"}&rdquo; and every sub-task beneath it will be
                                removed from the board. This cannot be undone from the interface.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
                            <Button
                                type="button"
                                variant="destructive"
                                disabled={isSubmitting}
                                data-slot="task-detail-delete-confirm"
                                onClick={(event) => {
                                    event.preventDefault();
                                    void handleDelete();
                                }}
                                className="min-h-11 md:min-h-0"
                            >
                                {isSubmitting ? (
                                    <>
                                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                        Deleting…
                                    </>
                                ) : (
                                    <>
                                        <Check className="size-4" aria-hidden="true" />
                                        Delete task
                                    </>
                                )}
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </SheetContent>
        </Sheet>
    );
}

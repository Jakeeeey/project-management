"use client";

import { TaskFormDialog, type TaskFormDialogProps } from "./TaskFormDialog";

/**
 * The add-sub-task dialog.
 *
 * It is deliberately a thin adapter over `TaskFormDialog` rather than a second form: a sub-task is
 * created by the same POST, validated by the same schema and carries the same fields as a top-level
 * task, so only the copy, the parent breadcrumb and the locked `parent_id` differ. A second form
 * would have meant two places to keep in step with the task contract.
 *
 * The prop surface is the form dialog's, minus the subject (this dialog only ever creates), so the
 * caller hands over exactly the callbacks it already holds.
 */
export type SubtaskCreateDialogProps = Omit<
    TaskFormDialogProps,
    "task" | "titleOverride" | "descriptionOverride"
>;

export function SubtaskCreateDialog({ parent, ...formProps }: SubtaskCreateDialogProps) {
    return (
        <TaskFormDialog
            {...formProps}
            task={null}
            parent={parent}
            titleOverride="Add sub-task"
            descriptionOverride={
                parent === null
                    ? "Add a sub-task to your department's board."
                    : `Add a sub-task under “${parent.title}”. Sub-tasks nest as deeply as the work needs.`
            }
        />
    );
}

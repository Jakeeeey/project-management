"use client";

import { TaskFormDialog, type TaskFormDialogProps } from "./TaskFormDialog";

/**
 * Thin adapter over `TaskFormDialog`: a sub-task shares the same POST, schema and fields,
 * so only the copy, parent breadcrumb and locked `parent_id` differ — a second form would
 * drift from the task contract.
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
                    ? "Add a sub-task to this list."
                    : `Add a sub-task under “${parent.title}”. Sub-tasks nest as deeply as the work needs.`
            }
        />
    );
}

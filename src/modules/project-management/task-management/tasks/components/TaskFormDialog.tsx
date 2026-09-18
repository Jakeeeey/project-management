"use client";

import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { ChevronRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { MemberAccessItem } from "@/modules/project-management/task-management/access/hooks/useAccess";
import {
    TaskCombobox,
    type TaskComboboxOption,
} from "./TaskCombobox";
import type { Capabilities } from "../types/capabilities";

import type { TaskCatalogOption, TaskCatalogs, TaskListItem } from "../hooks/useTasks";
import type { CreateTaskInput, UpdateTaskInput } from "../types/pm-task.schema";
import { AssigneeDialog } from "./AssigneeDialog";
import { AssigneeStack } from "./AssigneeStack";
import { DATE_RANGE_ERROR_MESSAGE, TaskDateRange, isValidDateRange } from "./TaskDateRange";
import { TaskDescriptionEditor } from "./TaskDescriptionEditor";
import { descriptionToStorage } from "./description-html";

/**
 * The create/edit dialog for a task or a sub-task.
 *
 * One dialog serves both verbs and both levels: `task === null` creates (under `parent` when it is a
 * sub-task) and a row edits it. Statuses and priorities are DATA — the two comboboxes render exactly
 * the department's live catalog rows passed in as `catalogs`, and an omitted status/priority falls
 * back to the department's default row exactly as the create route does.
 *
 * The assign picker is the ONE thing the actor's `capabilities.canAssign` gates: when the server says
 * `false` the control is not mounted at all (no disabled stub), because a plain member cannot assign.
 * Assignments ride on the existing `useAssignees` verbs — never on a task update — so an edit diffs
 * the selection against the row's current assignees and a create attaches them to the row the POST
 * just returned.
 *
 * Width is the QA checklist's `M` tier (`sm:max-w-[600px]`) plus `w-[95vw]` so it always fits a
 * phone. The body scrolls inside `max-h-[85vh]` while the header and footer stay pinned, Cancel
 * precedes Submit, and Submit is disabled for the whole in-flight window.
 */

const TaskFormSchema = z
    .object({
        title: z.string().trim().min(1, "Title is required").max(255, "Title must be 255 characters or fewer"),
        description: z.string().nullable(),
        /** `pm_task` requires both FKs, so a blank pick is an error rather than a silent fallback. */
        status_id: z.number().int().positive().nullable(),
        priority_id: z.number().int().positive().nullable(),
        start_date: z.string().nullable(),
        end_date: z.string().nullable(),
        /** Local to the form: assignments go through the assignees route, never a task update. */
        assignee_ids: z.array(z.number().int().positive()),
    })
    .superRefine((values, ctx) => {
        // `superRefine` rather than a per-field `refine`: a narrowing predicate would collapse the
        // inferred `number | null` to `number` and make the empty default unrepresentable.
        if (values.status_id === null) {
            ctx.addIssue({ code: "custom", path: ["status_id"], message: "Status is required" });
        }
        if (values.priority_id === null) {
            ctx.addIssue({ code: "custom", path: ["priority_id"], message: "Priority is required" });
        }
        if (!isValidDateRange(values.start_date, values.end_date)) {
            ctx.addIssue({ code: "custom", path: ["end_date"], message: DATE_RANGE_ERROR_MESSAGE });
        }
    });

type TaskFormValues = z.infer<typeof TaskFormSchema>;

const EMPTY_VALUES: TaskFormValues = {
    title: "",
    description: null,
    status_id: null,
    priority_id: null,
    start_date: null,
    end_date: null,
    assignee_ids: [],
};

/** Anchors the dates label to the start picker, so the composite control keeps a real label. */
const DATE_RANGE_ID_PREFIX = "task-form-dates";

/** One ancestor of the task being viewed or edited — the parent breadcrumb's building block. */
export interface TaskBreadcrumb {
    readonly id: number;
    readonly title: string;
}

export interface TaskFormDialogProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    /** The row being edited, or `null` to create. */
    readonly task: TaskListItem | null;
    /** The parent a new sub-task is created under; ignored when `task` is set. `null` means root. */
    readonly parent: TaskBreadcrumb | null;
    /** The chain from the root down to the task (create: to `parent`), rendered as a breadcrumb. */
    readonly parentTrail: readonly TaskBreadcrumb[];
    /** The department's live catalogs — the comboboxes' only source of options. */
    readonly catalogs: TaskCatalogs;
    /** The department's live members — the assign picker's only source of options. */
    readonly members: readonly MemberAccessItem[];
    /** Server-resolved capabilities; `canAssign` is the only gate on the assign control. */
    readonly capabilities: Capabilities | null;
    readonly isSubmitting: boolean;
    /** Creates the row and resolves its id (or `null` on failure) so assignees can be attached. */
    readonly onCreate: (input: CreateTaskInput) => Promise<number | null>;
    readonly onUpdate: (taskId: number, input: UpdateTaskInput) => Promise<boolean>;
    readonly onAssign: (taskId: number, userId: number, label: string) => Promise<boolean>;
    readonly onUnassign: (taskId: number, userId: number, label: string) => Promise<boolean>;
    /** Copy overrides so the sub-task dialog can reuse this form without a second implementation. */
    readonly titleOverride?: string;
    readonly descriptionOverride?: string;
}

/** The department's default row for a kind, falling back to the first live row. */
function defaultCatalogId(options: readonly TaskCatalogOption[]): number | null {
    if (options.length === 0) return null;
    const flagged = options.find((option) => option.is_default);
    return (flagged ?? options[0]).id;
}

export function TaskFormDialog({
    open,
    onOpenChange,
    task,
    parent,
    parentTrail,
    catalogs,
    members,
    capabilities,
    isSubmitting,
    onCreate,
    onUpdate,
    onAssign,
    onUnassign,
    titleOverride,
    descriptionOverride,
}: TaskFormDialogProps) {
    const isEditing = task !== null;
    const canAssign = capabilities?.canAssign === true;

    const form = useForm<TaskFormValues>({
        resolver: zodResolver(TaskFormSchema),
        defaultValues: EMPTY_VALUES,
    });

    // A reopened dialog must never remember the previous subject, so the values reset on every open.
    useEffect(() => {
        if (!open) return;
        form.reset({
            title: task?.title ?? "",
            description: task?.description ?? null,
            status_id: task?.status_id ?? defaultCatalogId(catalogs.statuses),
            priority_id: task?.priority_id ?? defaultCatalogId(catalogs.priorities),
            start_date: task?.start_date ?? null,
            end_date: task?.end_date ?? null,
            assignee_ids: task ? task.assignees.map((assignee) => assignee.user_id) : [],
        });
    }, [open, task, catalogs, form]);

    // `useWatch` rather than `form.watch(...)`: the latter is an incompatible-library call the React
    // Compiler refuses to memoize, which the module's lint gate rejects.
    const startDate = useWatch({ control: form.control, name: "start_date" }) ?? null;
    const endDate = useWatch({ control: form.control, name: "end_date" }) ?? null;

    const statusOptions = useMemo<TaskComboboxOption[]>(
        () =>
            catalogs.statuses.map((option) => ({
                value: String(option.id),
                label: option.label,
                color: option.color,
            })),
        [catalogs.statuses],
    );
    const priorityOptions = useMemo<TaskComboboxOption[]>(
        () =>
            catalogs.priorities.map((option) => ({
                value: String(option.id),
                label: option.label,
                color: option.color,
            })),
        [catalogs.priorities],
    );

    const [isAssigneeDialogOpen, setIsAssigneeDialogOpen] = useState(false);
    const [assigneeDialogTitle, setAssigneeDialogTitle] = useState("");

    /**
     * Opens the centered assignee modal. The subject's title is read at open time: on edit it is the
     * row's title (unless the field was just changed, which is the honest current draft), and on
     * create — where no row exists yet — the title being typed, falling back to a generic label.
     */
    const handleOpenAssigneeDialog = (): void => {
        setAssigneeDialogTitle(form.getValues("title").trim() || "this task");
        setIsAssigneeDialogOpen(true);
    };

    const nameOf = (userId: number): string =>
        members.find((member) => member.user_id === userId)?.full_name ?? `User #${userId}`;

    const handleSubmit = form.handleSubmit(async (values) => {
        const baseFields = {
            title: values.title.trim(),
            description: descriptionToStorage(values.description),
            status_id: values.status_id,
            priority_id: values.priority_id,
            start_date: values.start_date,
            end_date: values.end_date,
        };

        // The payload deliberately OMITS `custom_values`. Custom answers are edited inline in the
        // task table (and cleared there explicitly), so this form must not write them at all: the
        // server treats an omitted key as "leave every stored answer untouched", while a payload of
        // nulls would clear them. See TaskItemService.updateTask.
        if (task !== null) {
            const saved = await onUpdate(task.id, baseFields);
            if (!saved) return;

            // Assignments are diffed against the row's server truth, so an untouched picker writes
            // nothing at all.
            const current = new Set(task.assignees.map((assignee) => assignee.user_id));
            const next = new Set(values.assignee_ids);
            for (const userId of next) {
                if (!current.has(userId)) await onAssign(task.id, userId, nameOf(userId));
            }
            for (const userId of current) {
                if (!next.has(userId)) await onUnassign(task.id, userId, nameOf(userId));
            }
        } else {
            const createdId = await onCreate({
                ...baseFields,
                parent_id: parent?.id ?? null,
            });
            if (createdId === null) return;

            if (canAssign) {
                for (const userId of values.assignee_ids) {
                    await onAssign(createdId, userId, nameOf(userId));
                }
            }
        }

        onOpenChange(false);
    });

    const dialogTitle = titleOverride ?? (isEditing ? "Edit task" : "New task");
    const dialogDescription =
        descriptionOverride ??
        (isEditing
            ? "Change the title, status, priority, dates or assignees. Re-parenting lives in the Move to… action."
            : parent === null
              ? "Add a top-level task to your department's board. Statuses and priorities come from your department's own list."
              : "Add a sub-task under the parent shown below. Sub-tasks nest as deeply as the work needs.");

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[85vh] w-[95vw] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[600px]">
                <DialogHeader className="border-b px-6 pt-6 pb-4">
                    <DialogTitle className="line-clamp-1">{dialogTitle}</DialogTitle>
                    <DialogDescription>{dialogDescription}</DialogDescription>
                </DialogHeader>

                <Form {...form}>
                    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
                            <div className="space-y-1 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
                                <p className="text-xs font-medium text-muted-foreground">Parent</p>
                                {parentTrail.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">Top-level task</p>
                                ) : (
                                    <div
                                        data-slot="task-form-parent-breadcrumb"
                                        className="flex flex-wrap items-center gap-1 text-sm"
                                    >
                                        {parentTrail.map((ancestor, index) => (
                                            <span key={ancestor.id} className="flex min-w-0 items-center gap-1">
                                                {index > 0 ? (
                                                    <ChevronRight
                                                        className="size-3.5 shrink-0 text-muted-foreground"
                                                        aria-hidden="true"
                                                    />
                                                ) : null}
                                                <span
                                                    className={cn(
                                                        "max-w-[220px] truncate",
                                                        index === parentTrail.length - 1 && "font-medium",
                                                    )}
                                                    title={ancestor.title}
                                                >
                                                    {ancestor.title}
                                                </span>
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <FormField
                                control={form.control}
                                name="title"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>
                                            Title <span className="text-destructive">*</span>
                                        </FormLabel>
                                        <FormControl>
                                            <Input
                                                placeholder="What needs to be done?"
                                                autoComplete="off"
                                                {...field}
                                                value={field.value ?? ""}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            {/*
                             * Rich text (Quill). `TaskDescriptionEditor` owns the client-only editor and
                             * normalises a visually-empty document to `null` before it reaches the form,
                             * so an empty editor can never store an HTML shell; submit applies the same
                             * helper as the final storage boundary. `FormControl` still injects the label
                             * id/aria, which the editor forwards onto Quill's root (see that component).
                             */}
                            <FormField
                                control={form.control}
                                name="description"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Description</FormLabel>
                                        <FormControl>
                                            <TaskDescriptionEditor
                                                value={field.value}
                                                onChange={field.onChange}
                                                disabled={isSubmitting}
                                                placeholder="Add any detail the assignees need."
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            {/*
                             * Both catalog controls are `TaskCombobox`es: statuses and priorities are
                             * table rows, so the lists are searchable and each carries its own clear
                             * (X). The combobox names itself from `ariaLabel`, so these labels omit
                             * `htmlFor` rather than point at an id the control does not expose.
                             */}
                            <div className="grid gap-4 sm:grid-cols-2">
                                <FormField
                                    control={form.control}
                                    name="status_id"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel htmlFor={undefined}>
                                                Status <span className="text-destructive">*</span>
                                            </FormLabel>
                                            <TaskCombobox
                                                options={statusOptions}
                                                value={field.value === null ? null : String(field.value)}
                                                onValueChange={(value) =>
                                                    field.onChange(value === null ? null : Number(value))
                                                }
                                                placeholder="Pick a status"
                                                ariaLabel="Status"
                                                className="w-full"
                                            />
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={form.control}
                                    name="priority_id"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel htmlFor={undefined}>
                                                Priority <span className="text-destructive">*</span>
                                            </FormLabel>
                                            <TaskCombobox
                                                options={priorityOptions}
                                                value={field.value === null ? null : String(field.value)}
                                                onValueChange={(value) =>
                                                    field.onChange(value === null ? null : Number(value))
                                                }
                                                placeholder="Pick a priority"
                                                ariaLabel="Priority"
                                                className="w-full"
                                            />
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                            </div>

                            <FormField
                                control={form.control}
                                name="end_date"
                                render={() => (
                                    <FormItem>
                                        <FormLabel htmlFor={`${DATE_RANGE_ID_PREFIX}-start`}>Dates</FormLabel>
                                        <TaskDateRange
                                            idPrefix={DATE_RANGE_ID_PREFIX}
                                            startDate={startDate}
                                            endDate={endDate}
                                            onStartDateChange={(value) =>
                                                form.setValue("start_date", value, { shouldDirty: true })
                                            }
                                            onEndDateChange={(value) =>
                                                form.setValue("end_date", value, {
                                                    shouldDirty: true,
                                                    shouldValidate: true,
                                                })
                                            }
                                            disabled={isSubmitting}
                                        />
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            {canAssign ? (
                                <FormField
                                    control={form.control}
                                    name="assignee_ids"
                                    render={({ field }) => (
                                        <FormItem>
                                            {/*
                                             * The control is a TRIGGER, not the picker: it shows the
                                             * current selection and opens the shared centered modal. The
                                             * save contract is untouched — `assignee_ids` still carries
                                             * `number[]`, which the submit handler diffs against the
                                             * row's current assignees; `AssigneeDialog.onSave` already
                                             * converts its internal `string[]` totally, so no `NaN` can
                                             * reach the schema.
                                             */}
                                            <FormLabel htmlFor={undefined}>Assignees</FormLabel>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                onClick={handleOpenAssigneeDialog}
                                                disabled={isSubmitting}
                                                aria-label="Assignees"
                                                className="w-full justify-start"
                                            >
                                                <AssigneeStack
                                                    assignees={field.value.map((userId) => ({
                                                        user_id: userId,
                                                        full_name: nameOf(userId),
                                                    }))}
                                                    max={3}
                                                />
                                            </Button>
                                            <FormDescription>
                                                Only members of your department can be assigned.
                                            </FormDescription>
                                            <FormMessage />

                                            <AssigneeDialog
                                                open={isAssigneeDialogOpen}
                                                onOpenChange={setIsAssigneeDialogOpen}
                                                task={{
                                                    ...(task !== null ? { id: task.id } : {}),
                                                    title: assigneeDialogTitle,
                                                }}
                                                members={members}
                                                selectedIds={field.value}
                                                isSubmitting={isSubmitting}
                                                onSave={(userIds) => {
                                                    form.setValue("assignee_ids", [...userIds], {
                                                        shouldDirty: true,
                                                    });
                                                    setIsAssigneeDialogOpen(false);
                                                }}
                                            />
                                        </FormItem>
                                    )}
                                />
                            ) : null}
                        </div>

                        <DialogFooter className="justify-end border-t bg-muted/20 px-6 py-4">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                                disabled={isSubmitting}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={isSubmitting}
                                className="min-h-11 md:min-h-0"
                            >
                                {isSubmitting ? (
                                    <>
                                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                        Saving…
                                    </>
                                ) : isEditing ? (
                                    "Save changes"
                                ) : (
                                    "Create task"
                                )}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}

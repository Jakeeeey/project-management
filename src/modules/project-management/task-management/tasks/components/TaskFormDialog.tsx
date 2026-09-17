"use client";

import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Check, ChevronRight, ChevronsUpDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { MemberGrantItem } from "@/modules/project-management/task-management/access/hooks/useAssignmentGrants";
import { CatalogChipDot } from "@/modules/project-management/components/CatalogChip";
import type { Capabilities } from "@/modules/project-management/types/capabilities";

import type { TaskCatalogOption, TaskCatalogs, TaskField, TaskListItem } from "../hooks/useTasks";
import type { CreateTaskInput, UpdateTaskInput } from "../types/pm-task.schema";
import { DATE_RANGE_ERROR_MESSAGE, TaskDateRange, isValidDateRange } from "./TaskDateRange";
import { SingleDatePicker } from "./SingleDatePicker";

/**
 * The create/edit dialog for a task or a sub-task.
 *
 * One dialog serves both verbs and both levels: `task === null` creates (under `parent` when it is a
 * sub-task) and a row edits it. Statuses and priorities are DATA — the two selects render exactly
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

/** Radix `SelectItem` cannot carry an empty value, so "nothing chosen" is `""` (the placeholder). */
const NO_SELECTION = "";

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
        /**
         * The custom-column answers, keyed by column id as a string. They live in the form's own
         * store rather than a second `useState` so the existing `form.reset` on open resets them with
         * everything else, and a reopened dialog can never show the previous subject's answers.
         */
        custom_values: z.record(z.string(), z.string()),
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
    custom_values: {},
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
    /** The department's live catalogs — the selects' only source of options. */
    readonly catalogs: TaskCatalogs;
    /** The department's live members — the assign picker's only source of options. */
    readonly members: readonly MemberGrantItem[];
    /**
     * The department's custom columns. Each renders its own editor; the values live in local state
     * rather than the Zod schema because the set of columns is dynamic, and the server owns the
     * per-type validation (a `number` column rejecting `abc`, a `select` rejecting an unknown id).
     */
    readonly fields: readonly TaskField[];
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
    fields,
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

    const [pickerOpen, setPickerOpen] = useState(false);

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
            custom_values: Object.fromEntries(
                fields.map((field) => [
                    String(field.id),
                    task?.custom_values.find((entry) => entry.field_id === field.id)?.value ?? "",
                ]),
            ),
        });
    }, [open, task, catalogs, fields, form]);

    // `useWatch` rather than `form.watch(...)`: the latter is an incompatible-library call the React
    // Compiler refuses to memoize, which the module's lint gate rejects.
    const selectedIds = useWatch({ control: form.control, name: "assignee_ids" });
    const selectedSet = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
    const startDate = useWatch({ control: form.control, name: "start_date" }) ?? null;
    const endDate = useWatch({ control: form.control, name: "end_date" }) ?? null;
    const customValues = useWatch({ control: form.control, name: "custom_values" }) ?? {};

    const setCustomField = (fieldId: number, value: string): void => {
        form.setValue(
            "custom_values",
            { ...form.getValues("custom_values"), [String(fieldId)]: value },
            { shouldDirty: true },
        );
    };

    const selectedLabel = useMemo(() => {
        if (selectedSet.size === 0) return "Select members…";
        if (selectedSet.size === 1) {
            const only = members.find((member) => selectedSet.has(member.user_id));
            return only?.full_name ?? "1 member selected";
        }
        return `${selectedSet.size} members selected`;
    }, [selectedSet, members]);

    const nameOf = (userId: number): string =>
        members.find((member) => member.user_id === userId)?.full_name ?? `User #${userId}`;

    const handleSubmit = form.handleSubmit(async (values) => {
        const baseFields = {
            title: values.title.trim(),
            description: values.description?.trim() ? values.description.trim() : null,
            status_id: values.status_id,
            priority_id: values.priority_id,
            start_date: values.start_date,
            end_date: values.end_date,
        };

        // A blank answer is sent as `null` only when the task already stores one, so the write clears
        // it; on a create, blanks are omitted entirely and no empty row is written at all.
        const customValuesPayload = fields
            .map((field) => {
                const raw = (values.custom_values[String(field.id)] ?? "").trim();
                return { field_id: field.id, value: raw === "" ? null : raw };
            })
            .filter(
                (entry) =>
                    entry.value !== null ||
                    (task?.custom_values.some((stored) => stored.field_id === entry.field_id) ?? false),
            );

        if (task !== null) {
            const saved = await onUpdate(task.id, { ...baseFields, custom_values: customValuesPayload });
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
                custom_values: customValuesPayload,
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

                            <FormField
                                control={form.control}
                                name="description"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Description</FormLabel>
                                        <FormControl>
                                            <Textarea
                                                rows={4}
                                                placeholder="Add any detail the assignees need."
                                                className="min-h-[120px] resize-none"
                                                {...field}
                                                value={field.value ?? ""}
                                                onChange={(event) =>
                                                    field.onChange(
                                                        event.target.value === "" ? null : event.target.value,
                                                    )
                                                }
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <div className="grid gap-4 sm:grid-cols-2">
                                <FormField
                                    control={form.control}
                                    name="status_id"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>
                                                Status <span className="text-destructive">*</span>
                                            </FormLabel>
                                            <Select
                                                value={field.value === null ? NO_SELECTION : String(field.value)}
                                                onValueChange={(value) => field.onChange(Number(value))}
                                            >
                                                <FormControl>
                                                    <SelectTrigger
                                                        className="w-full"
                                                        aria-label="Status"
                                                        onBlur={field.onBlur}
                                                    >
                                                        <SelectValue placeholder="Pick a status" />
                                                    </SelectTrigger>
                                                </FormControl>
                                                <SelectContent className="max-h-80">
                                                    {catalogs.statuses.map((option) => (
                                                        <SelectItem key={option.id} value={String(option.id)}>
                                                            <CatalogChipDot
                                                                color={option.color}
                                                                density="comfortable"
                                                            />
                                                            <span className="min-w-0 truncate">
                                                                {option.label}
                                                            </span>
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={form.control}
                                    name="priority_id"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>
                                                Priority <span className="text-destructive">*</span>
                                            </FormLabel>
                                            <Select
                                                value={field.value === null ? NO_SELECTION : String(field.value)}
                                                onValueChange={(value) => field.onChange(Number(value))}
                                            >
                                                <FormControl>
                                                    <SelectTrigger
                                                        className="w-full"
                                                        aria-label="Priority"
                                                        onBlur={field.onBlur}
                                                    >
                                                        <SelectValue placeholder="Pick a priority" />
                                                    </SelectTrigger>
                                                </FormControl>
                                                <SelectContent className="max-h-80">
                                                    {catalogs.priorities.map((option) => (
                                                        <SelectItem key={option.id} value={String(option.id)}>
                                                            <CatalogChipDot
                                                                color={option.color}
                                                                density="comfortable"
                                                            />
                                                            <span className="min-w-0 truncate">
                                                                {option.label}
                                                            </span>
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
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
                                    render={({ field }) => {
                                        const toggle = (userId: number): void => {
                                            // Read the live store, not the captured `field.value`: two
                                            // picks resolved in the same tick would otherwise both start
                                            // from the pre-pick array and the first one would be lost.
                                            const next = new Set(form.getValues("assignee_ids"));
                                            if (next.has(userId)) next.delete(userId);
                                            else next.add(userId);
                                            field.onChange([...next]);
                                        };

                                        return (
                                            <FormItem>
                                                <FormLabel>Assignees</FormLabel>
                                                <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                                                    <PopoverTrigger asChild>
                                                        <FormControl>
                                                            <Button
                                                                type="button"
                                                                variant="outline"
                                                                role="combobox"
                                                                aria-expanded={pickerOpen}
                                                                aria-label="Assign department members"
                                                                onBlur={field.onBlur}
                                                                className="w-full justify-between"
                                                            >
                                                                <span
                                                                    className={cn(
                                                                        "min-w-0 flex-1 truncate text-left",
                                                                        selectedSet.size === 0 &&
                                                                            "text-muted-foreground",
                                                                    )}
                                                                >
                                                                    {selectedLabel}
                                                                </span>
                                                                <ChevronsUpDown
                                                                    className="ml-2 size-4 shrink-0 opacity-50"
                                                                    aria-hidden="true"
                                                                />
                                                            </Button>
                                                        </FormControl>
                                                    </PopoverTrigger>
                                                    <PopoverContent
                                                        align="start"
                                                        className="w-(--radix-popover-trigger-width) p-0"
                                                    >
                                                        <Command>
                                                            <CommandInput
                                                                placeholder="Search members by name or email…"
                                                                aria-label="Search department members"
                                                            />
                                                            <CommandList
                                                                className="max-h-64 overflow-y-auto overscroll-contain"
                                                                onWheel={(event) => event.stopPropagation()}
                                                            >
                                                                <CommandEmpty>
                                                                    No matching member.
                                                                </CommandEmpty>
                                                                <CommandGroup heading="Members">
                                                                    {members.map((member) => (
                                                                        <CommandItem
                                                                            key={member.user_id}
                                                                            value={`${member.user_id} ${member.full_name} ${member.user_email ?? ""}`}
                                                                            onSelect={() => toggle(member.user_id)}
                                                                        >
                                                                            <Check
                                                                                className={cn(
                                                                                    "mr-2 size-4 shrink-0",
                                                                                    selectedSet.has(member.user_id)
                                                                                        ? "opacity-100"
                                                                                        : "opacity-0",
                                                                                )}
                                                                                aria-hidden="true"
                                                                            />
                                                                            <span
                                                                                className="min-w-0 flex-1 truncate"
                                                                                title={member.full_name}
                                                                            >
                                                                                {member.full_name}
                                                                            </span>
                                                                            {member.user_email ? (
                                                                                <span className="ml-2 max-w-[45%] truncate text-xs text-muted-foreground">
                                                                                    {member.user_email}
                                                                                </span>
                                                                            ) : null}
                                                                        </CommandItem>
                                                                    ))}
                                                                </CommandGroup>
                                                            </CommandList>
                                                        </Command>
                                                    </PopoverContent>
                                                </Popover>
                                                <FormDescription>
                                                    Only members of your department can be assigned.
                                                </FormDescription>
                                                <FormMessage />
                                            </FormItem>
                                        );
                                    }}
                                />
                            ) : null}

                            {fields.length > 0 ? (
                                <div className="space-y-4 rounded-lg border border-border/50 bg-muted/20 p-3">
                                    <div className="space-y-0.5">
                                        <p className="text-sm font-medium">Custom fields</p>
                                        <p className="text-xs text-muted-foreground">
                                            Your department&apos;s own columns. Leave one blank to clear it.
                                        </p>
                                    </div>

                                    {fields.map((field) => {
                                        const inputId = `task-field-${field.id}`;
                                        const value = customValues[String(field.id)] ?? "";

                                        return (
                                            <div key={field.id} className="space-y-1.5">
                                                <label htmlFor={inputId} className="text-sm font-medium">
                                                    {field.label}
                                                </label>

                                                {field.field_type === "select" ? (
                                                    <Select
                                                        value={value}
                                                        onValueChange={(next) => setCustomField(field.id, next)}
                                                    >
                                                        <SelectTrigger
                                                            id={inputId}
                                                            className="w-full"
                                                            aria-label={field.label}
                                                        >
                                                            <SelectValue placeholder="Not set" />
                                                        </SelectTrigger>
                                                        <SelectContent className="max-h-80">
                                                            {field.options.map((option) => (
                                                                <SelectItem
                                                                    key={option.id}
                                                                    value={String(option.id)}
                                                                >
                                                                    <span className="min-w-0 truncate">
                                                                        {option.label}
                                                                    </span>
                                                                </SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                ) : field.field_type === "date" ? (
                                                    <SingleDatePicker
                                                        id={inputId}
                                                        aria-label={field.label}
                                                        value={value === "" ? null : value}
                                                        onChange={(next) => setCustomField(field.id, next ?? "")}
                                                        disabled={isSubmitting}
                                                    />
                                                ) : (
                                                    <Input
                                                        id={inputId}
                                                        aria-label={field.label}
                                                        autoComplete="off"
                                                        inputMode={
                                                            field.field_type === "number" ? "decimal" : undefined
                                                        }
                                                        placeholder={
                                                            field.field_type === "number"
                                                                ? "e.g. 42"
                                                                : "Add a value"
                                                        }
                                                        value={value}
                                                        onChange={(event) =>
                                                            setCustomField(field.id, event.target.value)
                                                        }
                                                    />
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
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

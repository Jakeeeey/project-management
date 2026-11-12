"use client";

import { useMemo, useState } from "react";
import { Bookmark, ChevronDown, Info, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    TaskCombobox,
    type TaskComboboxOption,
} from "./TaskCombobox";

import { SingleDatePicker } from "./SingleDatePicker";
import {
    ASSIGNEE_FIELD_KEY,
    FILTER_GROUP_LABELS,
    FILTER_OPERATORS,
    FILTER_OPERATOR_LABELS,
    PRIORITY_FIELD_KEY,
    STATUS_FIELD_KEY,
    TAGS_FIELD_KEY,
    createFilterClause,
    createFilterGroup,
    customFieldIdFromKey,
    fieldFilterKey,
    fieldKind,
    isClauseActive,
    operatorTakesValue,
    operatorsForKind,
    type FilterClause,
    type FilterGroup,
    type FilterGroupOperator,
    type FilterOperator,
    type SavedTaskFilter,
} from "./task-filter";
import type { TaskField } from "../hooks/useTasks";

/**
 * The tasks FILTER BUILDER: the modal BODY — groups of `[field] [operator] [value] [remove]` rows,
 * `+ Add filter` inside a group, `+ Add group`, and a `Saved filters` dropdown.
 *
 * TWO levels, and the difference matters: GROUPS always combine with AND (every group must be
 * satisfied), while ROWS inside one group combine by that group's own operator — `Match all` is the
 * strict AND the module had before, `Match any` is the OR that lets one question read "this tag,
 * and either status A or B" as two groups: `[Tags is X]` and `[Status is A or Status B]`.
 *
 * The modal supplies the `Filters` title (see `TaskFilterControl`), so this renders no heading of its
 * own and no outer card: it is a plain vertical stack so it can fill the dialog body without a box
 * inside a box. The `filters-info` tooltip stays here because it explains how the rows combine.
 *
 * Purely presentational and fully controlled — the orchestrator owns the groups and the saved sets,
 * and this file never fetches, stores or derives a filter. The two pieces of local state it does keep
 * are the save-name input's open flag and its draft text, which are transient UI.
 *
 * Each row's value control switches on the field's TYPE: status / priority / tags and a custom
 * `select` offer their catalog options (choice ids, never labels), a custom `date` uses the module's
 * day picker, `text` / `number` use a plain input, and assignee offers the department members. The empty
 * operators take no value, so that control renders disabled. Picking a different FIELD clears the
 * row's value, because an option id from one column is meaningless in another.
 */

/** A choice option a value control renders; `TaskCatalogOption` / `TaskFieldOption` satisfy it. */
export interface FilterBuilderOption {
    readonly id: number;
    readonly label: string;
    /** Stored 6-digit hex, or `null` — rendered as the option's leading dot. */
    readonly color: string | null;
}

/** A department member the assignee value control renders. */
export interface FilterBuilderMember {
    readonly user_id: number;
    readonly full_name: string;
}

export interface TaskFilterBuilderProps {
    readonly groups: readonly FilterGroup[];
    readonly onGroupsChange: (next: readonly FilterGroup[]) => void;
    /** The department's ENABLED custom columns — the list's own `fields`, never a second fetch. */
    readonly fields: readonly TaskField[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    /** The department's tag catalog — the same shareable list every task surface reads. */
    readonly tags: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    /** Used only to mark the signed-in member's own row in the assignee value control. */
    readonly currentUserId: number | null;
    readonly savedFilters: readonly SavedTaskFilter[];
    readonly onSaveFilter: (name: string, groups: readonly FilterGroup[]) => void;
    readonly onApplySavedFilter: (filter: SavedTaskFilter) => void;
    readonly onDeleteSavedFilter: (id: string) => void;
}

/** A radix `Select` value back to an operator; an unknown string falls back to `Is`. */
function toOperator(value: string): FilterOperator {
    return (FILTER_OPERATORS as readonly string[]).includes(value) ? (value as FilterOperator) : "is";
}

/** A non-blank combobox value, or `null` — the control's "nothing chosen" state. */
function orNull(value: string | null): string | null {
    return value === null || value === "" ? null : value;
}

/** A `TaskCombobox` over `{ id, label, color }` options, comparing by id — never by label. */
function ChoiceValueControl({
    ariaLabel,
    placeholder,
    options,
    value,
    onChange,
}: {
    readonly ariaLabel: string;
    readonly placeholder: string;
    readonly options: readonly FilterBuilderOption[];
    readonly value: string | null;
    readonly onChange: (value: string | null) => void;
}) {
    const comboboxOptions = useMemo<TaskComboboxOption[]>(
        () => options.map((option) => ({ value: String(option.id), label: option.label, color: option.color })),
        [options],
    );

    return (
        <TaskCombobox
            ariaLabel={ariaLabel}
            placeholder={placeholder}
            searchPlaceholder="Search..."
            className="w-full"
            options={comboboxOptions}
            value={orNull(value)}
            onValueChange={onChange}
        />
    );
}

/**
 * The value control for one row, switched on the field's type.
 *
 * `disabled` is the empty-operator (and no-field) state: the control is rendered but inert, so the
 * row keeps its shape without offering a value that the operator cannot use.
 */
function FilterValueControl({
    clause,
    fields,
    statuses,
    priorities,
    tags,
    members,
    currentUserId,
    onChange,
}: {
    readonly clause: FilterClause;
    readonly fields: readonly TaskField[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    readonly tags: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    readonly currentUserId: number | null;
    readonly onChange: (value: string | null) => void;
}) {
    const takesValue = operatorTakesValue(clause.operator) && clause.fieldKey !== null;

    if (!takesValue) {
        return (
            <Input
                disabled
                value=""
                placeholder="No value"
                aria-label="Filter value (not used by this operator)"
                className="w-full"
                data-slot="task-filter-value-disabled"
            />
        );
    }

    const ariaLabel = "Filter value";

    if (clause.fieldKey === STATUS_FIELD_KEY) {
        return (
            <ChoiceValueControl
                ariaLabel={`${ariaLabel} (status)`}
                placeholder="Any status"
                options={statuses}
                value={clause.value}
                onChange={onChange}
            />
        );
    }

    if (clause.fieldKey === PRIORITY_FIELD_KEY) {
        return (
            <ChoiceValueControl
                ariaLabel={`${ariaLabel} (priority)`}
                placeholder="Any priority"
                options={priorities}
                value={clause.value}
                onChange={onChange}
            />
        );
    }

    if (clause.fieldKey === TAGS_FIELD_KEY) {
        return (
            <ChoiceValueControl
                ariaLabel={`${ariaLabel} (tag)`}
                placeholder="Any tag"
                options={tags}
                value={clause.value}
                onChange={onChange}
            />
        );
    }

    if (clause.fieldKey === ASSIGNEE_FIELD_KEY) {
        const memberOptions = members.map((member) => ({
            id: member.user_id,
            label: member.user_id === currentUserId ? `${member.full_name} (you)` : member.full_name,
            color: null,
        }));
        return (
            <ChoiceValueControl
                ariaLabel={`${ariaLabel} (assignee)`}
                placeholder="Anyone"
                options={memberOptions}
                value={clause.value}
                onChange={onChange}
            />
        );
    }

    const fieldId = customFieldIdFromKey(clause.fieldKey);
    const field = fieldId === null ? undefined : fields.find((candidate) => candidate.id === fieldId);

    if (field !== undefined && field.field_type === "select") {
        return (
            <ChoiceValueControl
                ariaLabel={`${ariaLabel} (${field.label})`}
                placeholder={`Any ${field.label}`}
                options={field.options}
                value={clause.value}
                onChange={onChange}
            />
        );
    }

    if (field !== undefined && field.field_type === "date") {
        return (
            <SingleDatePicker
                value={clause.value}
                onChange={onChange}
                aria-label={`${ariaLabel} (${field.label})`}
                placeholder={`Any ${field.label}`}
                className="w-full"
            />
        );
    }

    if (field !== undefined && field.field_type === "number") {
        return (
            <Input
                type="number"
                inputMode="decimal"
                value={clause.value ?? ""}
                onChange={(event) => onChange(event.target.value)}
                placeholder={`Filter ${field.label}`}
                aria-label={`${ariaLabel} (${field.label})`}
                className="w-full"
            />
        );
    }

    return (
        <Input
            type="text"
            value={clause.value ?? ""}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field === undefined ? "Filter value" : `Search ${field.label}`}
            aria-label={field === undefined ? ariaLabel : `${ariaLabel} (${field.label})`}
            className="w-full"
        />
    );
}

/** One builder row: field picker, operator picker, value control, remove button. */
function FilterClauseRow({
    clause,
    fields,
    statuses,
    priorities,
    tags,
    members,
    currentUserId,
    onChange,
    onRemove,
}: {
    readonly clause: FilterClause;
    readonly fields: readonly TaskField[];
    readonly statuses: readonly FilterBuilderOption[];
    readonly priorities: readonly FilterBuilderOption[];
    readonly tags: readonly FilterBuilderOption[];
    readonly members: readonly FilterBuilderMember[];
    readonly currentUserId: number | null;
    readonly onChange: (next: FilterClause) => void;
    readonly onRemove: () => void;
}) {
    const fieldOptions = useMemo<TaskComboboxOption[]>(
        () => [
            { value: STATUS_FIELD_KEY, label: "Status" },
            { value: PRIORITY_FIELD_KEY, label: "Priority" },
            { value: ASSIGNEE_FIELD_KEY, label: "Assignee" },
            { value: TAGS_FIELD_KEY, label: "Tags" },
            ...fields.map((field) => ({ value: fieldFilterKey(field.id), label: field.label })),
        ],
        [fields],
    );

    const operators = operatorsForKind(fieldKind(clause.fieldKey, fields));

    /** Changing the field clears the value and coerces the operator to one the new kind supports. */
    const changeField = (fieldKey: string | null): void => {
        const kind = fieldKind(fieldKey, fields);
        const allowed = operatorsForKind(kind);
        onChange({
            ...clause,
            fieldKey,
            operator: allowed.includes(clause.operator) ? clause.operator : "is",
            value: null,
        });
    };

    return (
        /*
         * ONE clause = ONE row, responsive at the `sm:` tier the module's own dialogs already use.
         *
         * Below `sm:` the row STACKS: a 2-track grid where the field and the operator each span both
         * tracks (one control per line) and the value shares its line with the trailing remove
         * button. Squeezing all four tracks into a phone width crushed the field and value controls
         * (they truncated to "S…" / "No valu") while the operator's hard floor consumed the rest, so
         * at phone width each control gets its own full-width line and renders its label whole.
         *
         * From `sm:` up the layout is the original 4-track row, unchanged: field and value are
         * `minmax(0, …)` flexible (they shrink and their text truncates), while the OPERATOR track
         * carries a hard `9rem` FLOOR. That floor is wider than the longest operator label
         * ("Is not empty", ~84px at `text-sm`) plus the trigger's own padding and chevron, so the
         * operator can never be squeezed into wrapping — the bug this row previously had. `min-w-0`
         * on each flexible child lets a long option label truncate inside its control instead of
         * widening the row or overflowing the modal. The `9rem` floor lives ONLY in the `sm:`
         * template: in the stacked layout the operator is full-width, so a floor there would only
         * force a horizontal overflow.
         */
        <div
            data-slot="task-filter-row"
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1.25fr)_minmax(9rem,1fr)_minmax(0,1.25fr)_auto]"
        >
            <TaskCombobox
                ariaLabel="Filter field"
                placeholder="Select field"
                searchPlaceholder="Search fields..."
                className="col-span-2 w-full min-w-0 sm:col-span-1"
                options={fieldOptions}
                value={clause.fieldKey}
                onValueChange={changeField}
            />

            <Select value={clause.operator} onValueChange={(next) => onChange({ ...clause, operator: toOperator(next) })}>
                {/*
                 * The trigger already sets `whitespace-nowrap`, but the primitive ALSO puts
                 * `line-clamp-1` and `flex` on the `select-value` span, and that `display` conflict
                 * can drop the clamp and let the label break. Re-asserting `whitespace-nowrap` on the
                 * span itself makes the single-line rule explicit and independent of which utility
                 * wins — the operator track's `9rem` floor (above) is what guarantees the text is
                 * not merely clipped. Behaviour, keyboard interaction and styling are untouched.
                 * `col-span-2`/`sm:col-span-1` only widens the trigger on the stacked layout.
                 */}
                <SelectTrigger
                    className="col-span-2 w-full min-w-0 whitespace-nowrap sm:col-span-1 [&_[data-slot=select-value]]:whitespace-nowrap"
                    aria-label="Filter operator"
                >
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {operators.map((operator) => (
                        <SelectItem key={operator} value={operator} className="whitespace-nowrap">
                            {FILTER_OPERATOR_LABELS[operator]}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            <div className="w-full min-w-0">
                <FilterValueControl
                    clause={clause}
                    fields={fields}
                    statuses={statuses}
                    priorities={priorities}
                    tags={tags}
                    members={members}
                    currentUserId={currentUserId}
                    onChange={(value) => onChange({ ...clause, value })}
                />
            </div>

            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove filter"
                title="Remove filter"
                data-slot="task-filter-remove"
                className="shrink-0 justify-self-end text-muted-foreground hover:text-destructive"
                onClick={onRemove}
            >
                <Trash2 className="size-4" aria-hidden="true" />
            </Button>
        </div>
    );
}

export function TaskFilterBuilder({
    groups,
    onGroupsChange,
    fields,
    statuses,
    priorities,
    tags,
    members,
    currentUserId,
    savedFilters,
    onSaveFilter,
    onApplySavedFilter,
    onDeleteSavedFilter,
}: TaskFilterBuilderProps) {
    const [isNaming, setIsNaming] = useState(false);
    const [draftName, setDraftName] = useState("");

    const activeClauseCount = groups.reduce(
        (total, group) => total + group.clauses.filter(isClauseActive).length,
        0,
    );

    const replaceGroup = (next: FilterGroup): void => {
        onGroupsChange(groups.map((group) => (group.id === next.id ? next : group)));
    };

    const removeGroup = (groupId: string): void => {
        onGroupsChange(groups.filter((group) => group.id !== groupId));
    };

    const addGroup = (): void => {
        onGroupsChange([...groups, createFilterGroup()]);
    };

    /** The empty state's one-click start: a first AND group holding one fresh row. */
    const addFirstClause = (): void => {
        onGroupsChange([{ ...createFilterGroup("and"), clauses: [createFilterClause()] }]);
    };

    const addClause = (groupId: string): void => {
        onGroupsChange(
            groups.map((group) =>
                group.id === groupId ? { ...group, clauses: [...group.clauses, createFilterClause()] } : group,
            ),
        );
    };

    const updateClause = (groupId: string, next: FilterClause): void => {
        onGroupsChange(
            groups.map((group) =>
                group.id === groupId
                    ? { ...group, clauses: group.clauses.map((clause) => (clause.id === next.id ? next : clause)) }
                    : group,
            ),
        );
    };

    const removeClause = (groupId: string, clauseId: string): void => {
        onGroupsChange(
            groups.map((group) =>
                group.id === groupId
                    ? { ...group, clauses: group.clauses.filter((clause) => clause.id !== clauseId) }
                    : group,
            ),
        );
    };

    const commitSave = (): void => {
        if (draftName.trim() === "" || activeClauseCount === 0) return;
        onSaveFilter(draftName, groups);
        setDraftName("");
        setIsNaming(false);
    };

    return (
        <div data-slot="task-filter-builder" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label="How filters combine"
                                data-slot="filters-info"
                                className="text-muted-foreground"
                            >
                                <Info className="size-4" aria-hidden="true" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-64">
                            Groups combine with AND: a task must satisfy every group. Inside a group,
                            rows combine by its own setting — Match all needs every row, Match any needs
                            one. A row with no field, or a value-taking row with no value, is ignored.
                        </TooltipContent>
                    </Tooltip>
                </div>

                {isNaming ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            autoFocus
                            value={draftName}
                            onChange={(event) => setDraftName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    commitSave();
                                }
                                if (event.key === "Escape") {
                                    setIsNaming(false);
                                    setDraftName("");
                                }
                            }}
                            placeholder="Filter name"
                            aria-label="Saved filter name"
                            className="h-9 w-40"
                        />
                        <Button
                            type="button"
                            size="sm"
                            onClick={commitSave}
                            disabled={draftName.trim() === ""}
                        >
                            Save
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                setIsNaming(false);
                                setDraftName("");
                            }}
                        >
                            Cancel
                        </Button>
                    </div>
                ) : (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                data-slot="saved-filters-trigger"
                                aria-label="Saved filters"
                            >
                                <Bookmark className="size-4" aria-hidden="true" />
                                Saved filters
                                <ChevronDown className="size-4" aria-hidden="true" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuLabel>Saved filters</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {savedFilters.length === 0 ? (
                                <DropdownMenuItem disabled>No saved filters</DropdownMenuItem>
                            ) : (
                                savedFilters.map((filter) => (
                                    <DropdownMenuSub key={filter.id}>
                                        <DropdownMenuSubTrigger>
                                            <span className="min-w-0 truncate">{filter.name}</span>
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent>
                                            <DropdownMenuItem onSelect={() => onApplySavedFilter(filter)}>
                                                Apply
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                variant="destructive"
                                                onSelect={() => onDeleteSavedFilter(filter.id)}
                                            >
                                                Delete
                                            </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                ))
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                disabled={activeClauseCount === 0}
                                onSelect={() => setIsNaming(true)}
                            >
                                Save current filters…
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            {groups.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    No filters yet. Add one to narrow the list.
                </p>
            ) : (
                <div className="space-y-2">
                    {groups.map((group) => (
                        <section
                            key={group.id}
                            data-slot="task-filter-group"
                            className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3"
                        >
                            <div className="flex items-center justify-between gap-2">
                                <Select
                                    value={group.operator}
                                    onValueChange={(next) =>
                                        replaceGroup({
                                            ...group,
                                            operator: (next === "or" ? "or" : "and") as FilterGroupOperator,
                                        })
                                    }
                                >
                                    <SelectTrigger
                                        className="h-8 w-36 whitespace-nowrap"
                                        aria-label="How this group's rows combine"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="and" className="whitespace-nowrap">
                                            {FILTER_GROUP_LABELS.and}
                                        </SelectItem>
                                        <SelectItem value="or" className="whitespace-nowrap">
                                            {FILTER_GROUP_LABELS.or}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>

                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    aria-label="Remove group"
                                    title="Remove group"
                                    data-slot="task-filter-remove-group"
                                    className="text-muted-foreground hover:text-destructive"
                                    onClick={() => removeGroup(group.id)}
                                >
                                    <Trash2 className="size-4" aria-hidden="true" />
                                </Button>
                            </div>

                            {group.clauses.map((clause) => (
                                <FilterClauseRow
                                    key={clause.id}
                                    clause={clause}
                                    fields={fields}
                                    statuses={statuses}
                                    priorities={priorities}
                                    tags={tags}
                                    members={members}
                                    currentUserId={currentUserId}
                                    onChange={(next) => updateClause(group.id, next)}
                                    onRemove={() => removeClause(group.id, clause.id)}
                                />
                            ))}

                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                data-slot="task-filter-add"
                                onClick={() => addClause(group.id)}
                            >
                                <Plus className="size-4" aria-hidden="true" />
                                Add filter
                            </Button>
                        </section>
                    ))}
                </div>
            )}

            <Button
                type="button"
                variant="outline"
                size="sm"
                data-slot="task-filter-add-group"
                onClick={groups.length === 0 ? addFirstClause : addGroup}
            >
                <Plus className="size-4" aria-hidden="true" />
                {groups.length === 0 ? "Add filter" : "Add group"}
            </Button>
        </div>
    );
}

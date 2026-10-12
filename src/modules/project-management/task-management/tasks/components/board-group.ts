import type { TaskCatalogOption, TaskCatalogs, TaskField, TaskListItem } from "../hooks/useTasks";
import { assigneeName } from "../types/task-view";
import { assigneeColorFor } from "./assignee-color";
import { parseDateOnly } from "./SingleDatePicker";

/**
 * The board's grouping model, kept apart from its rendering.
 *
 * A group dimension turns the department's flat rows into ordered, labelled COLUMNS. Two rules hold
 * for every dimension, because a board that breaks either one reads as broken:
 *
 * 1. A task may sit in MORE THAN ONE column — membership is not a partition. Assignee grouping is the
 *    reason: a task with three assignees belongs in three columns, all of them.
 * 2. A column for rows that carry no value at all ("Unassigned", "No date", "No value") always sorts
 *    LAST, and `direction` never moves it. It is a residual, not a rank.
 */

/** The axis the board groups by when nothing else is chosen. */
export const BOARD_DEFAULT_GROUP_ID = "status";

/** The built-in due-date axis; every other non-built-in axis is a custom column, addressed as `field:<id>`. */
export const BOARD_GROUP_DUE_DATE_ID = "due_date";

const BOARD_FIELD_PREFIX = "field:";

/** Suffix that identifies a residual column, chosen so it can never collide with a real row id. */
const RESIDUAL = "__none";

const DAY_MS = 24 * 60 * 60 * 1000;

export type BoardGroupDirection = "asc" | "desc";

/** One selectable axis of the "Group by" control. */
export interface BoardGroupDimension {
    readonly id: string;
    readonly label: string;
}

/** What dropping a card into a column writes. An absolute target, never a delta. */
export type BoardDropTarget =
    | { readonly kind: "status"; readonly statusId: number }
    | { readonly kind: "priority"; readonly priorityId: number }
    | { readonly kind: "field"; readonly fieldId: number; readonly value: string };

/** One rendered column: everything the header needs, plus the cards it holds. */
export interface BoardGroupColumn {
    readonly key: string;
    readonly label: string;
    readonly color: string | null;
    readonly icon: string | null;
    readonly cards: readonly TaskListItem[];
    /**
     * What a drop into this column writes, or `null` when the column is not a drop target
     * (residual columns, assignee/date axes, text/number fields).
     */
    readonly drop: BoardDropTarget | null;
}

export interface BoardGroupContext {
    readonly catalogs: TaskCatalogs;
    readonly fields: readonly TaskField[];
    readonly memberNameById: ReadonlyMap<number, string>;
}

/** A column before its cards are collected; `matches` decides membership. */
interface ColumnSpec {
    readonly key: string;
    readonly label: string;
    readonly color: string | null;
    readonly icon: string | null;
    readonly drop: BoardDropTarget | null;
    readonly matches: (item: TaskListItem) => boolean;
}

/** The board's built-in axes first, then every custom column in the department's own order. */
export function boardGroupDimensions(fields: readonly TaskField[]): BoardGroupDimension[] {
    return [
        { id: "status", label: "Status" },
        { id: "assignee", label: "Assignee" },
        { id: "priority", label: "Priority" },
        { id: BOARD_GROUP_DUE_DATE_ID, label: "Due date" },
        ...fields.map((field) => ({
            id: `${BOARD_FIELD_PREFIX}${field.id}`,
            label: field.label,
        })),
    ];
}

/** The axis a dimension id names, or `null` when the custom column no longer exists. */
export function findBoardGroupDimension(
    dimensionId: string,
    fields: readonly TaskField[],
): BoardGroupDimension | null {
    return boardGroupDimensions(fields).find((dimension) => dimension.id === dimensionId) ?? null;
}

/**
 * Turns the rows into columns for one dimension.
 *
 * `direction` reverses the NAMED columns only — the residual always stays last. Columns with no cards
 * are kept: an empty column is a real state of the data, and on a board it is also a target.
 */
export function groupBoardItems(
    items: readonly TaskListItem[],
    dimensionId: string,
    direction: BoardGroupDirection,
    context: BoardGroupContext,
    today: Date = startOfToday(),
): BoardGroupColumn[] {
    return buildSpecs(items, dimensionId, direction, context, today).map((spec) => ({
        key: spec.key,
        label: spec.label,
        color: spec.color,
        icon: spec.icon,
        cards: items.filter(spec.matches),
        drop: spec.drop,
    }));
}

function buildSpecs(
    items: readonly TaskListItem[],
    dimensionId: string,
    direction: BoardGroupDirection,
    context: BoardGroupContext,
    today: Date,
): ColumnSpec[] {
    if (dimensionId === "status") {
        return catalogSpecs(
            context.catalogs.statuses,
            "status",
            (item) => item.status_id,
            (option) => ({ kind: "status", statusId: option.id }),
            direction,
            items,
            "No status",
        );
    }

    if (dimensionId === "priority") {
        return catalogSpecs(
            context.catalogs.priorities,
            "priority",
            (item) => item.priority_id,
            (option) => ({ kind: "priority", priorityId: option.id }),
            direction,
            items,
            "No priority",
        );
    }

    if (dimensionId === "assignee") {
        return assigneeSpecs(items, direction, context.memberNameById);
    }

    if (dimensionId === BOARD_GROUP_DUE_DATE_ID) {
        return urgencySpecs(items, "due_date", (item) => item.end_date, direction, today);
    }

    const field = findField(dimensionId, context.fields);
    if (field === null) {
        return [];
    }

    if (field.field_type === "select") {
        return selectFieldSpecs(field, items, direction);
    }

    if (field.field_type === "date") {
        return urgencySpecs(
            items,
            dimensionId,
            (item) => readFieldValue(item, field.id),
            direction,
            today,
        );
    }

    return valueFieldSpecs(field, items, direction);
}

/** `field:<id>` → the column, or `null` when the id is not a known custom column. */
function findField(dimensionId: string, fields: readonly TaskField[]): TaskField | null {
    if (!dimensionId.startsWith(BOARD_FIELD_PREFIX)) {
        return null;
    }

    const id = Number(dimensionId.slice(BOARD_FIELD_PREFIX.length));
    return fields.find((field) => field.id === id) ?? null;
}

/** The stored answer for one custom column, normalised so a blank string counts as no answer. */
function readFieldValue(item: TaskListItem, fieldId: number): string | null {
    const stored = item.custom_values.find((value) => value.field_id === fieldId)?.value ?? null;
    return stored === null || stored === "" ? null : stored;
}

/** A catalog axis: one column per catalog row, in the department's own order. */
function catalogSpecs(
    options: readonly TaskCatalogOption[],
    groupId: string,
    idOf: (item: TaskListItem) => number,
    dropOf: (option: TaskCatalogOption) => BoardDropTarget,
    direction: BoardGroupDirection,
    items: readonly TaskListItem[],
    residualLabel: string,
): ColumnSpec[] {
    const named = [...options]
        .sort((left, right) => left.sort_order - right.sort_order || left.id - right.id)
        .map((option) => ({
            key: `${groupId}:${option.id}`,
            label: option.label,
            color: option.color,
            icon: option.icon,
            drop: dropOf(option),
            matches: (item: TaskListItem) => idOf(item) === option.id,
        }));

    /*
     * NOT dead code: the server hands a row a `null` ref when its status_id/priority_id resolves to
     * nothing, so a deleted catalog row leaves rows addressing no column — which would silently drop
     * them from the board. Appended only while such rows exist, so the ordinary board is exactly its
     * catalogs.
     */
    const isOrphan = (item: TaskListItem): boolean =>
        !options.some((option) => option.id === idOf(item));

    const residual: ColumnSpec[] = items.some(isOrphan)
        ? [
              {
                  key: `${groupId}:${RESIDUAL}`,
                  label: residualLabel,
                  color: null,
                  icon: null,
                  drop: null,
                  matches: isOrphan,
              },
          ]
        : [];

    return [...withDirection(named, direction), ...residual];
}

/**
 * The people axis. Membership is an OR over a task's assignees, so a task with several assignees
 * appears in each of their columns rather than in one arbitrary "primary" column.
 */
function assigneeSpecs(
    items: readonly TaskListItem[],
    direction: BoardGroupDirection,
    memberNameById: ReadonlyMap<number, string>,
): ColumnSpec[] {
    const userIds = new Set<number>();
    for (const item of items) {
        for (const assignee of item.assignees) {
            userIds.add(assignee.user_id);
        }
    }

    const named = [...userIds]
        .sort((left, right) => {
            const byName = assigneeName(left, memberNameById).localeCompare(
                assigneeName(right, memberNameById),
            );
            return byName !== 0 ? byName : left - right;
        })
        .map((userId) => ({
            key: `assignee:${userId}`,
            label: assigneeName(userId, memberNameById),
            color: assigneeColorFor(userId),
            icon: null,
            drop: null,
            matches: (item: TaskListItem) =>
                item.assignees.some((assignee) => assignee.user_id === userId),
        }));

    return [
        ...withDirection(named, direction),
        {
            key: `assignee:${RESIDUAL}`,
            label: "Unassigned",
            color: null,
            icon: null,
            drop: null,
            matches: (item: TaskListItem) => item.assignees.length === 0,
        },
    ];
}

/** The urgency ladder a date dimension sorts into, earliest first. */
const URGENCY_ORDER = ["overdue", "today", "next-7", "later"] as const;

type Urgency = (typeof URGENCY_ORDER)[number] | "none";

const URGENCY_LABELS: Record<(typeof URGENCY_ORDER)[number], string> = {
    overdue: "Overdue",
    today: "Today",
    "next-7": "Next 7 days",
    later: "Later",
};

const URGENCY_WINDOW_DAYS = 7;

/**
 * Which rung of the ladder one date falls on, measured in whole local days so a stored `YYYY-MM-DD`
 * can never drift a bucket by a timezone offset. A `null` or malformed date is `"none"`, the
 * residual rung, never "overdue".
 */
function urgencyOf(value: string | null, today: Date): Urgency {
    const date = parseDateOnly(value);
    if (date === undefined) {
        return "none";
    }

    const day = date.getTime();
    const base = today.getTime();

    if (day < base) {
        return "overdue";
    }
    if (day === base) {
        return "today";
    }
    if (day <= base + URGENCY_WINDOW_DAYS * DAY_MS) {
        return "next-7";
    }
    return "later";
}

/** A date axis. The rung is resolved once per row, so no card is parsed more than once. */
function urgencySpecs(
    items: readonly TaskListItem[],
    groupId: string,
    valueOf: (item: TaskListItem) => string | null,
    direction: BoardGroupDirection,
    today: Date,
): ColumnSpec[] {
    const rungByTask = new Map<number, Urgency>();
    for (const item of items) {
        rungByTask.set(item.id, urgencyOf(valueOf(item), today));
    }

    const named = URGENCY_ORDER.map((rung) => ({
        key: `${groupId}:${rung}`,
        label: URGENCY_LABELS[rung],
        color: null,
        icon: null,
        drop: null,
        matches: (item: TaskListItem) => rungByTask.get(item.id) === rung,
    }));

    return [
        ...withDirection(named, direction),
        {
            key: `${groupId}:${RESIDUAL}`,
            label: "No date",
            color: null,
            icon: null,
            drop: null,
            matches: (item: TaskListItem) => rungByTask.get(item.id) === "none",
        },
    ];
}

/**
 * A select column: one column per configured choice, matched on the stored option id.
 *
 * A row holding a stale option id — a choice deleted after the answer was written — lands on the
 * residual, never in a column that no longer exists.
 */
function selectFieldSpecs(
    field: TaskField,
    items: readonly TaskListItem[],
    direction: BoardGroupDirection,
): ColumnSpec[] {
    const valueByTask = new Map<number, string | null>();
    for (const item of items) {
        valueByTask.set(item.id, readFieldValue(item, field.id));
    }

    const named = [...field.options]
        .sort((left, right) => left.sort_order - right.sort_order || left.id - right.id)
        .map((option) => ({
            key: `${BOARD_FIELD_PREFIX}${field.id}:${option.id}`,
            label: option.label,
            color: option.color,
            icon: option.icon,
            drop: {
                kind: "field",
                fieldId: field.id,
                value: String(option.id),
            } as const,
            matches: (item: TaskListItem) => valueByTask.get(item.id) === String(option.id),
        }));

    const optionIds = new Set(field.options.map((option) => String(option.id)));

    return [
        ...withDirection(named, direction),
        residualSpec(`${BOARD_FIELD_PREFIX}${field.id}`, "No value", (item) => {
            const value = valueByTask.get(item.id) ?? null;
            return value === null || !optionIds.has(value);
        }),
    ];
}

/** A free-text or number column: one column per distinct stored value. */
function valueFieldSpecs(
    field: TaskField,
    items: readonly TaskListItem[],
    direction: BoardGroupDirection,
): ColumnSpec[] {
    const valueByTask = new Map<number, string | null>();
    for (const item of items) {
        valueByTask.set(item.id, readFieldValue(item, field.id));
    }

    const distinct = new Set<string>();
    for (const value of valueByTask.values()) {
        if (value !== null) {
            distinct.add(value);
        }
    }

    const ordered = [...distinct].sort((left, right) =>
        field.field_type === "number"
            ? Number(left) - Number(right)
            : left.localeCompare(right),
    );

    const named = (direction === "desc" ? [...ordered].reverse() : ordered).map((value) => ({
        key: `${BOARD_FIELD_PREFIX}${field.id}:text:${value}`,
        label: value,
        color: null,
        icon: null,
        drop: null,
        matches: (item: TaskListItem) => valueByTask.get(item.id) === value,
    }));

    return [
        ...named,
        residualSpec(
            `${BOARD_FIELD_PREFIX}${field.id}`,
            "No value",
            (item) => (valueByTask.get(item.id) ?? null) === null,
        ),
    ];
}

function residualSpec(
    groupId: string,
    label: string,
    isResidual: (item: TaskListItem) => boolean,
): ColumnSpec {
    return {
        key: `${groupId}:${RESIDUAL}`,
        label,
        color: null,
        icon: null,
        drop: null,
        matches: isResidual,
    };
}

/** Reverses the named columns for a descending order; the residual is appended after this. */
function withDirection(specs: ColumnSpec[], direction: BoardGroupDirection): ColumnSpec[] {
    return direction === "desc" ? [...specs].reverse() : specs;
}

function startOfToday(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

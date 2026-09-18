"use client";

import { cn } from "@/lib/utils";
import { SingleDatePicker } from "./SingleDatePicker";

/**
 * The one message an invalid range shows, wherever it is surfaced: inline here and in the
 * form-level `FormMessage` the dialog renders from the same predicate.
 */
export const DATE_RANGE_ERROR_MESSAGE = "End date must be on or after the start date.";

/** `YYYY-MM-DD` — the only shape the pickers emit and the only one `pm_task` stores. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `end >= start` rule as a pure predicate, so the create/edit dialog can re-run it on submit
 * (inside its Zod refinement) instead of trusting that the UI never let an invalid pair through.
 *
 * Both ends are optional, so a half-open range is valid. A present-but-malformed value is NOT
 * valid — the pickers cannot produce one, but a hand-built request can.
 *
 * The comparison is a plain string compare: zero-padded `YYYY-MM-DD` sorts lexicographically in
 * date order, so no `Date` — and therefore no timezone — enters the rule.
 */
export function isValidDateRange(
    startDate: string | null | undefined,
    endDate: string | null | undefined,
): boolean {
    if (!startDate || !endDate) return true;
    if (!DATE_ONLY_PATTERN.test(startDate) || !DATE_ONLY_PATTERN.test(endDate)) return false;
    return endDate >= startDate;
}

export interface TaskDateRangeProps {
    startDate: string | null;
    endDate: string | null;
    onStartDateChange: (value: string | null) => void;
    onEndDateChange: (value: string | null) => void;
    disabled?: boolean;
    /** Accessible names of the two fields; also the clear buttons' labels. */
    startLabel?: string;
    endLabel?: string;
    startPlaceholder?: string;
    endPlaceholder?: string;
    /** Prefix for the two trigger ids: `${idPrefix}-start` / `${idPrefix}-end`. */
    idPrefix?: string;
    className?: string;
}

/**
 * The linked start/end pair for a task.
 *
 * `end >= start` is enforced by disabling every day before the start in the end picker — the
 * constraint is applied where the invalid choice would be made, not merely reported after it. The
 * same rule is re-validated on submit through `isValidDateRange`, and an invalid pair that did get
 * through (parent-set defaults, a form reset) renders inline with `DATE_RANGE_ERROR_MESSAGE`.
 *
 * The start picker is deliberately NOT capped at the end date: moving the start past an existing
 * end is a normal edit, and it must surface the constraint instead of being silently impossible
 * to express.
 */
export function TaskDateRange({
    startDate,
    endDate,
    onStartDateChange,
    onEndDateChange,
    disabled = false,
    startLabel = "Start date",
    endLabel = "End date",
    startPlaceholder = "Pick a start date",
    endPlaceholder = "Pick an end date",
    idPrefix = "task-date-range",
    className,
}: TaskDateRangeProps) {
    const rangeIsValid = isValidDateRange(startDate, endDate);

    return (
        <div
            data-slot="task-date-range"
            data-invalid={!rangeIsValid}
            className={cn("grid gap-2", className)}
        >
            <div className="grid gap-3 sm:grid-cols-2">
                <SingleDatePicker
                    id={`${idPrefix}-start`}
                    aria-label={startLabel}
                    placeholder={startPlaceholder}
                    value={startDate}
                    onChange={onStartDateChange}
                    disabled={disabled}
                />
                <SingleDatePicker
                    id={`${idPrefix}-end`}
                    aria-label={endLabel}
                    placeholder={endPlaceholder}
                    value={endDate}
                    onChange={onEndDateChange}
                    disabled={disabled}
                    minDate={startDate}
                />
            </div>

            {!rangeIsValid && (
                <p
                    role="alert"
                    data-slot="task-date-range-error"
                    className="text-destructive text-sm"
                >
                    {DATE_RANGE_ERROR_MESSAGE}
                </p>
            )}
        </div>
    );
}

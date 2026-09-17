"use client";

import { useMemo } from "react";
import { CalendarIcon, X } from "lucide-react";
import type { Matcher } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { cn, formatDateLong, isValidDate, toISODate } from "@/lib/utils";

/**
 * `YYYY-MM-DD` calendar date — the only shape `pm_task.start_date` / `end_date` (MySQL `DATE`)
 * round-trips without a time component.
 *
 * Parsing goes through the string's numeric parts instead of `new Date(value)`: the spec reads a
 * bare date-only string as UTC midnight, so every timezone behind UTC would render — and re-emit —
 * the previous day. A Date built from local parts stays on the wall-clock day the user picked,
 * which is what makes `toISODate(parseDateOnly(v)) === v` hold in every timezone, Philippine time
 * included (PHP is UTC+8, so this is the direction that would hide a `toISOString()` bug).
 *
 * @returns A local-midnight `Date` for a real calendar day, or `undefined` for empty/malformed
 *          input. An impossible day such as `2026-02-31` rolls over in the `Date` constructor and
 *          is rejected on the round-trip check rather than silently accepted as 3 March.
 */
export function parseDateOnly(value: string | null | undefined): Date | undefined {
    if (!value) return undefined;

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null) return undefined;

    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!isValidDate(date)) return undefined;

    return toISODate(date) === value ? date : undefined;
}

/** Turns an inclusive min/max pair into day-picker matchers; `undefined` keeps every day selectable. */
function buildDisabledMatchers(
    minDate: string | null | undefined,
    maxDate: string | null | undefined,
): Matcher[] | undefined {
    const matchers: Matcher[] = [];

    const min = parseDateOnly(minDate);
    if (min !== undefined) matchers.push({ before: min });

    const max = parseDateOnly(maxDate);
    if (max !== undefined) matchers.push({ after: max });

    return matchers.length > 0 ? matchers : undefined;
}

export interface SingleDatePickerProps {
    /** The selected calendar date as `YYYY-MM-DD`, or `null` when nothing is selected. */
    value: string | null;
    /** Emits `YYYY-MM-DD`, or `null` when the day is cleared. Never a `Date`, never a timestamp. */
    onChange: (value: string | null) => void;
    /** Accessible name of the field — e.g. `"Start date"`. Also labels the clear button. */
    "aria-label": string;
    disabled?: boolean;
    placeholder?: string;
    /** Forwarded to the trigger so an external `<Label htmlFor>` can point at it. */
    id?: string;
    /** Inclusive lower bound (`YYYY-MM-DD`); every earlier day renders disabled. */
    minDate?: string | null;
    /** Inclusive upper bound (`YYYY-MM-DD`); every later day renders disabled. */
    maxDate?: string | null;
    className?: string;
}

/**
 * A controlled single-day picker composed from the shared `Popover` + `Calendar` primitives.
 *
 * The value contract is a plain `YYYY-MM-DD` string — never a `Date` and never
 * `toISOString()` — because a UTC round-trip shifts the wall-clock day for this app's users.
 * There is deliberately no `<input type="date">`: the QA checklist classifies a bare date input as
 * a legacy outlier, and it cannot express the disabled-day bounds this picker shares with its
 * range partner.
 */
export function SingleDatePicker({
    value,
    onChange,
    disabled = false,
    placeholder = "Pick a date",
    id,
    minDate,
    maxDate,
    className,
    "aria-label": ariaLabel,
}: SingleDatePickerProps) {
    const date = parseDateOnly(value);
    const disabledMatchers = useMemo(() => buildDisabledMatchers(minDate, maxDate), [minDate, maxDate]);

    // The visible text stays on the trigger, but `aria-label` always wins as the accessible name —
    // so it carries both the field's name and the selected day instead of hiding the value.
    const triggerLabel = date === undefined ? ariaLabel : `${ariaLabel}, ${formatDateLong(date)}`;

    const handleSelect = (selected: Date | undefined) => {
        onChange(selected === undefined ? null : toISODate(selected));
    };

    return (
        <div className={cn("relative", className)}>
            <Popover>
                <PopoverTrigger asChild>
                    <Button
                        id={id}
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        aria-label={triggerLabel}
                        data-slot="single-date-picker-trigger"
                        data-empty={date === undefined}
                        className={cn(
                            "w-full justify-start gap-2 text-left font-normal",
                            date === undefined && "text-muted-foreground",
                            date !== undefined && !disabled && "pr-8",
                        )}
                    >
                        <CalendarIcon className="size-4 shrink-0 opacity-70" aria-hidden="true" />
                        <span className="truncate">
                            {date === undefined ? placeholder : formatDateLong(date)}
                        </span>
                    </Button>
                </PopoverTrigger>

                <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                        mode="single"
                        selected={date}
                        onSelect={handleSelect}
                        defaultMonth={date}
                        disabled={disabledMatchers}
                        autoFocus
                    />
                </PopoverContent>
            </Popover>

            {date !== undefined && !disabled && (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Clear ${ariaLabel}`}
                    title={`Clear ${ariaLabel}`}
                    data-slot="single-date-picker-clear"
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => onChange(null)}
                >
                    <X className="size-3.5" aria-hidden="true" />
                </Button>
            )}
        </div>
    );
}

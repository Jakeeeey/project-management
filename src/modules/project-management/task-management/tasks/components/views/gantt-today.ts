/**
 * The "current day" marker for the read-only Gantt timeline.
 *
 * Kept out of `GanttView.tsx` on purpose: the view imports the vendor's stylesheet and mounts a
 * `next/dynamic` chunk, neither of which a plain Node assertion script can resolve. This module is
 * dependency-free, so `isSameLocalDay` / `highlightToday` can be unit-tested directly without
 * mocking the clock (`isSameLocalDay(date, reference)`).
 */

/** The class `highlightTime` returns for today's day cell. Its rule lives in `GanttView.tsx`. */
export const GANTT_TODAY_CLASS = "pm-task-gantt-today";

/**
 * True when `date` falls on the same LOCAL calendar day as `today`.
 *
 * The comparison uses local calendar parts (`getFullYear` / `getMonth` / `getDate`), never
 * `getTime()` and never a UTC accessor. The chart hands us a `Date` built in the viewer's local
 * zone, and "today" is the viewer's local day: comparing epochs would also match the wrong day once
 * the two instants are more than 24h apart, and comparing UTC parts would mark tomorrow's column
 * during the eight evening hours at UTC+8 that already belong to the next UTC date.
 *
 * `today` is injectable so the rule can be exercised for any fixed date without touching the system
 * clock.
 */
export function isSameLocalDay(date: Date, today: Date = new Date()): boolean {
    return (
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate()
    );
}

/**
 * The `highlightTime` callback: returns {@link GANTT_TODAY_CLASS} for today's day cell and `""` for
 * every other cell.
 *
 * The vendor calls this once per visible scale cell with the cell's `date` and the scale row's
 * `unit`. The default scales are month + day, so `unit` is normally `"day"`; coarser rows
 * (year/month/week) and an hour-level zoom pass a different unit and are deliberately left
 * unmarked — the guard returns `""` for anything that is not `"day"` rather than assuming. `today`
 * is injectable for the same reason as in {@link isSameLocalDay}.
 */
export function highlightToday(
    date: Date,
    unit: "day" | "hour",
    today: Date = new Date(),
): string {
    if (unit !== "day") {
        return "";
    }

    return isSameLocalDay(date, today) ? GANTT_TODAY_CLASS : "";
}

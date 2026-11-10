import type { Schedule } from "./types";

/** Directus/MySQL datetime columns may omit an offset; those values are UTC. */
export function parseUtcTimestamp(value: string): number {
 const text = value.trim().replace(" ", "T");
 return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : `${text}Z`);
}

export function localDate(instant: string | Date, timezone = "Asia/Manila"): string {
 return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}
export function addDays(date: string, days: number): string {
 const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
/** Convert a local wall clock to UTC, rejecting nonexistent DST times. */
export function wallToUtc(date: string, time: string, timezone: string): string {
 const wall = `${date}T${time.length === 5 ? time + ":00" : time}`;
 const target = Date.parse(wall + "Z"); let guess = target;
 const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
 for (let i = 0; i < 4; i++) {
  const shown = Date.parse(formatter.format(new Date(guess)).replace(" ", "T") + "Z");
  const delta = target - shown; if (!delta) return new Date(guess).toISOString(); guess += delta;
 }
 throw new Error("Local time does not exist in the selected timezone.");
}
export function scheduleDates(schedule: Schedule, through: string): string[] {
 const result: string[] = []; const start = new Date(schedule.start_date + "T00:00:00Z");
 const end = schedule.end_date && schedule.end_date < through ? schedule.end_date : through;
 // Deliberately bounded; long-lived production schedules need a persisted generation cursor.
 let scanned = 0;
 for (let date = schedule.start_date; date <= end; date = addDays(date, 1)) {
  if (++scanned > 36600) throw new Error("Schedule exceeds the supported 100-year range.");
  const d = new Date(date + "T00:00:00Z"); const elapsed = Math.round((+d - +start) / 86400000);
  const weekday = d.getUTCDay() || 7; const weekStart = (start.getUTCDay() || 7) - 1;
  const weeks = Math.floor((elapsed + weekStart) / 7);
  const months = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth() - start.getUTCMonth();
  const frequency = schedule.frequency === "CUSTOM" ? ({ DAY: "DAILY", WEEK: "WEEKLY", MONTH: "MONTHLY" } as const)[schedule.interval_unit ?? "DAY"] : schedule.frequency;
  let matches = frequency === "ONCE" ? elapsed === 0 : frequency === "DAILY" ? elapsed % schedule.interval_value === 0 && (!schedule.days_of_week.length || schedule.days_of_week.includes(weekday)) : frequency === "WEEKLY" ? weeks % schedule.interval_value === 0 && schedule.days_of_week.includes(weekday) : false;
  if (frequency === "MONTHLY") {
   const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
   const requested = schedule.day_of_month ?? start.getUTCDate();
   const day = schedule.month_end_policy === "SKIP" && requested > last ? -1 : Math.min(requested, last);
   matches = months % schedule.interval_value === 0 && d.getUTCDate() === day;
  }
  if (matches) { result.push(date); if (schedule.until_count && result.length >= schedule.until_count) break; }
 }
 return result;
}

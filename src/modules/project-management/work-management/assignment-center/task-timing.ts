import { z } from "zod";
import { wallToUtc } from "./recurrence";

/** Browser date/time values are local wall clocks, never browser-timezone instants. */
export function validateTaskTiming(start: string, time: string, available: string, end = "") {
 if (!z.iso.date().safeParse(start).success) throw new Error("Choose a valid first due date.");
 if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time)) throw new Error("Choose a valid due time.");
 const match = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)$/.exec(available);
 if (!match || !z.iso.date().safeParse(match[1]).success) throw new Error("Choose a valid Available from date and time.");
 if (end && (!z.iso.date().safeParse(end).success || end < start)) throw new Error("The schedule end date must be on or after the first due date.");
 const availability_start_at = wallToUtc(match[1], match[2], "Asia/Manila");
 const first_due_at = wallToUtc(start, time, "Asia/Manila");
 if (availability_start_at > first_due_at) throw new Error("Available from must be on or before the first deadline (Manila time). Move the first due date later or make the task available earlier.");
 return { availability_start_at, first_due_at };
}

import type { TaskFieldType } from "../types/task-field.schema";

/**
 * The pure value codec for custom columns: the one place that knows what a string means for each
 * declared column type, and how it is normalised before it is stored.
 *
 * A custom column's type is chosen at runtime, so `pm_task_field_value.value` is a single `TEXT`
 * column and the type is what gives it meaning. Keeping the four rules here — free of any Directus
 * import — means they stay assertable in isolation and cannot drift from the Zod contract that
 * carries them.
 *
 * `select` is the one type this file cannot fully decide: an answer must be the id of a **live
 * choice of that same column**, which needs a read, so the service owns it and this file only
 * normalises the text.
 */

/** The coded refusal the service re-throws as its own 400. */
export class TaskFieldValueError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TaskFieldValueError";
    }
}

/** `YYYY-MM-DD` — `pm_task_field_value.value` holds a DATE column's answer in this exact shape. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The longest text answer, matching `TaskFieldValueInputSchema`'s cap so the two can never disagree. */
export const MAX_FIELD_TEXT_LENGTH = 2000;

/**
 * Normalises one answer for storage, or throws `TaskFieldValueError` when it cannot be one.
 *
 * An empty or whitespace-only string is **cleared to `null`**, not stored as `""`, so "no answer" has
 * exactly one representation and a `select` can never carry a blank id.
 */
export function normaliseFieldValue(type: TaskFieldType, raw: string | null): string | null {
    if (raw === null) return null;
    const value = raw.trim();
    if (value === "") return null;

    switch (type) {
        case "text":
            if (value.length > MAX_FIELD_TEXT_LENGTH) {
                throw new TaskFieldValueError(
                    `A text answer must be ${MAX_FIELD_TEXT_LENGTH} characters or fewer`,
                );
            }
            return value;
        case "number": {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) {
                throw new TaskFieldValueError("A number column only accepts a number");
            }
            return String(parsed);
        }
        case "date":
            if (!DATE_ONLY.test(value)) {
                throw new TaskFieldValueError("A date column only accepts a YYYY-MM-DD date");
            }
            return value;
        case "select":
            return value;
    }
}
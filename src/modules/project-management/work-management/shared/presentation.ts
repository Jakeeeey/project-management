import type { Frequency } from "../types";

export const frequencyLabels: Record<Frequency, string> = { ONCE: "One-time", DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly", CUSTOM: "Custom" };
export const selectClass = "h-9 rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring";

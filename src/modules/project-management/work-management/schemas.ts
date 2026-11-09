import { z } from "zod";
const date = z.iso.date();
export const ScheduleSchema = z.object({
 frequency: z.enum(["ONCE", "DAILY", "WEEKLY", "MONTHLY", "CUSTOM"]),
 interval_value: z.number().int().min(1).max(365).default(1),
 interval_unit: z.enum(["DAY", "WEEK", "MONTH"]).optional(),
 days_of_week: z.array(z.number().int().min(1).max(7)).max(7).default([]),
 day_of_month: z.number().int().min(1).max(31).optional(),
 month_end_policy: z.enum(["CLAMP_TO_LAST_DAY", "SKIP"]).default("CLAMP_TO_LAST_DAY"),
 due_local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/),
 timezone: z.string().max(64).default("Asia/Manila").refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }),
 start_date: date, end_date: date.optional(), until_count: z.number().int().min(1).max(36600).optional(),
}).superRefine((s, ctx) => {
 if (s.end_date && s.end_date < s.start_date) ctx.addIssue({ code: "custom", message: "End date precedes start date." });
 if (new Set(s.days_of_week).size !== s.days_of_week.length) ctx.addIssue({ code: "custom", message: "Duplicate weekdays." });
 if ((s.frequency === "WEEKLY" || s.frequency === "CUSTOM" && s.interval_unit === "WEEK") && !s.days_of_week.length) ctx.addIssue({ code: "custom", message: "Choose at least one weekday." });
 if (s.frequency === "CUSTOM" && !s.interval_unit) ctx.addIssue({ code: "custom", message: "Custom schedule needs an interval unit." });
 if (s.frequency === "ONCE" && s.interval_value !== 1) ctx.addIssue({ code: "custom", message: "One-time interval must be 1." });
});
export const TaskInput = z.object({
 title: z.string().trim().min(1).max(255), description: z.string().trim().min(1).max(50000),
 scope_type: z.enum(["DEPARTMENT", "GLOBAL"]), department_id: z.string().regex(/^\d+$/).optional(),
 assignee_user_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(100),
 report_to_user_id: z.string().regex(/^\d+$/).optional(),
 priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
 availability_start_at: z.iso.datetime({ offset: true }), schedule: ScheduleSchema,
 reference_file_ids: z.array(z.string()).max(10).default([]),
});
export const Amendment = TaskInput.extend({ expected_revision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) });
export const SubmissionInput = z.object({ file_upload_ids: z.array(z.string()).min(1, "Attach at least one deliverable file.").max(10), remark: z.string().max(10000).default(""), revision_reason: z.string().max(2000).default(""), expected_revision: z.number().int().positive() });
export const ReasonInput = z.object({ reason: z.string().trim().min(1).max(2000), expected_revision: z.number().int().positive() });
export const DeadlineInput = ReasonInput.extend({ due_at: z.iso.datetime({ offset: true }) });

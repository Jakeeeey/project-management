import { createHash } from "node:crypto";
import { emptyState, WorkEngine } from "./engine";
import { requireRule, WorkError } from "./policies";
import { TaskInput } from "./schemas";
import type { Employee } from "./types";
import type { DatabaseRow, WorkDatabase } from "./directus-client";

export interface TaskSaveResult { id: string; assignment_count: number; occurrence_count: number; persistence: "directus"; atomic: false }
const rowId = (row: DatabaseRow) => {
 requireRule(typeof row.id === "string" || typeof row.id === "number" && Number.isSafeInteger(row.id), 502, "INVALID_INSERT_ID", "Directus did not return a safe record ID.");
 return String(row.id);
};

/** Directus REST writer; compensating cleanup is best-effort, not a database transaction. */
export class TaskWriter {
  constructor(private db: WorkDatabase, private now = new Date().toISOString()) {}
  async save(actor: Employee, employees: Employee[], raw: unknown, key: string): Promise<TaskSaveResult> {
  requireRule(/^[A-Za-z0-9:_-]{8,128}$/.test(key), 422, "IDEMPOTENCY_REQUIRED", "Provide a valid idempotency key.");
  const input = TaskInput.parse(raw);
    requireRule(!input.reference_file_ids.length, 422, "REFERENCE_FILES_UNAVAILABLE", "Reference attachments are not currently available.");
  for (const userId of input.assignee_user_ids) requireRule(employees.find(e => e.id === userId)?.department_id, 422, "ASSIGNEE_DEPARTMENT_REQUIRED", "Each assignee needs an existing department before work can be assigned.");
  const state = emptyState(); state.employees = employees;
  const engine = new WorkEngine(state, actor, "assignor", this.now);
  const task = engine.create(input, key); // Authorization and full validation happen before writes.
    requireRule(state.occurrences.length <= 1000, 422, "OCCURRENCE_LIMIT", "This schedule creates too many obligations. Shorten the schedule or select fewer employees.");
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
   // Include the historical command key so existing idempotency records remain effective.
   const scope = { actor_key: { _eq: `wm:user:${actor.id}` }, operation: { _in: ["task:create", "dummy:create-task"] }, idempotency_key: { _eq: key } };
  const previous = (await this.db.read("pm_work_idempotency", ["id", "state", "request_sha256", "response_body"], scope, 1))[0];
  if (previous) {
   requireRule(previous.request_sha256 === hash, 409, "IDEMPOTENCY_MISMATCH", "This save key was already used for different task details.");
    requireRule(previous.state === "COMPLETED", 409, "SAVE_IN_PROGRESS", "This save is pending or needs inspection. Retry the same request later; do not create a duplicate.");
    return (typeof previous.response_body === "string" ? JSON.parse(previous.response_body) : previous.response_body) as TaskSaveResult;
  }
  // The unique database key also prevents concurrent requests from owning the same command.
  const reservation = await this.db.create("pm_work_idempotency", {
    actor_key: `wm:user:${actor.id}`, operation: "task:create", idempotency_key: key, request_sha256: hash,
   state: "IN_PROGRESS", created_at: this.now, expires_at: new Date(Date.parse(this.now) + 86400000).toISOString(),
  });
  const journal: { collection: string; ids: string[] }[] = [{ collection: "pm_work_idempotency", ids: [rowId(reservation)] }];
  let taskId: string | null = null;
  const one = async (collection: string, body: DatabaseRow) => {
   const row = await this.db.create(collection, body); journal.push({ collection, ids: [rowId(row)] }); return row;
  };
  const many = async (collection: string, bodies: DatabaseRow[], fields: string[]) => {
   const rows: DatabaseRow[] = [];
   for (let offset = 0; offset < bodies.length; offset += 100) {
    const batch = await this.db.createMany(collection, bodies.slice(offset, offset + 100), fields);
    journal.push({ collection, ids: batch.map(rowId) }); rows.push(...batch);
   }
   return rows;
  };
  try {
   const taskRow = await one("pm_work_task", {
     title: task.title, description: task.description,
    scope_type: task.scope_type, department_id: task.department_id, created_by: actor.id, report_to_user_id: task.report_to_user_id,
    priority: task.priority, availability_start_at: task.availability_start_at, schedule_type: task.schedule.frequency,
    revision_number: 1, lifecycle_status: "ACTIVE", created_at: this.now, updated_at: this.now,
   });
   taskId = rowId(taskRow);
   const snapshot = { ...task, id: taskId, description: String(taskRow.description ?? task.description) };
    const revision = await one("pm_work_task_revision", { task_id: taskId, revision_number: 1, changed_by: actor.id, change_reason: "Initial task creation", snapshot, changed_at: this.now });
   const s = task.schedule;
   const recurrence = await one("pm_work_recurrence", {
    task_id: taskId, schedule_version: 1, frequency: s.frequency, interval_value: s.interval_value,
    interval_unit: s.frequency === "CUSTOM" ? s.interval_unit : null, days_of_week: s.days_of_week,
    day_of_month: s.day_of_month ?? null, month_end_policy: s.month_end_policy, due_local_time: s.due_local_time,
    timezone: s.timezone, start_date: s.start_date, end_date: s.end_date ?? null, until_count: s.until_count ?? null,
    effective_from: s.start_date, created_at: this.now,
   });
   const assignments = await many("pm_work_assignment", state.assignments.map(a => ({
    task_id: taskId, assignee_user_id: a.assignee_user_id, department_id_at_assignment: a.department_id_at_assignment,
    assigned_by: actor.id, assigned_at: this.now, status: "ACTIVE",
   })), ["id", "assignee_user_id"]);
   const assignmentByUser = new Map(assignments.map(a => [String(a.assignee_user_id), rowId(a)]));
   const occurrenceRows = state.occurrences.map(o => {
    const assignment = state.assignments.find(a => a.id === o.assignment_id)!;
    return { task_id: taskId, assignment_id: assignmentByUser.get(assignment.assignee_user_id), recurrence_id: rowId(recurrence), task_revision_id: rowId(revision), occurrence_key: o.occurrence_key, scheduled_local_date: o.scheduled_local_date, available_at: o.available_at, original_due_at: o.original_due_at, due_at: o.due_at, row_version: 1, status: o.status, created_at: this.now, updated_at: this.now };
   });
   const occurrences = await many("pm_work_occurrence", occurrenceRows, ["id", "assignment_id", "occurrence_key"]);
   const occurrenceByKey = new Map(occurrences.map(o => [`${o.assignment_id}:${o.occurrence_key}`, rowId(o)]));
   const realOccurrenceId = (internal: string | null) => {
    if (!internal) return null;
    const occurrence = state.occurrences.find(o => o.id === internal)!;
    const assignment = state.assignments.find(a => a.id === occurrence.assignment_id)!;
    return occurrenceByKey.get(`${assignmentByUser.get(assignment.assignee_user_id)}:${occurrence.occurrence_key}`) ?? null;
   };
   const events = await many("pm_work_audit_event", state.events.map(event => {
    const occurrence = realOccurrenceId(event.occurrence_id);
     return { event_type: event.event_type, actor_id: actor.id, entity_type: occurrence ? "occurrence" : "task", entity_id: occurrence ?? taskId, task_id: taskId, occurrence_id: occurrence, task_revision_number: 1, old_values: null, new_values: event.event_type === "TASK_CREATED" ? snapshot : event.new_values, reason: "Task created", request_id: key, created_at: this.now };
   }), ["id", "event_type", "occurrence_id"]);
   const recipients = [...new Set([actor.id, task.report_to_user_id, ...state.assignments.map(a => a.assignee_user_id)])];
    await many("pm_work_outbox", events.map(event => ({ event_id: rowId(event), type: String(event.event_type), payload: { task_id: taskId, occurrence_id: event.occurrence_id, recipients }, dedupe_key: `work:${rowId(event)}`, attempts: 0, next_attempt_at: this.now, created_at: this.now })), ["id"]);
    const result: TaskSaveResult = { id: taskId, assignment_count: assignments.length, occurrence_count: occurrences.length, persistence: "directus", atomic: false };
   await this.db.update("pm_work_idempotency", rowId(reservation), { state: "COMPLETED", completed_at: this.now, response_status: 201, response_body: result });
   // Notification delivery is best-effort after the save has completed; never undo
   // a successful task because delivery failed. The outbox remains retryable.
   const rootEvent = events.find(event => event.event_type === "TASK_CREATED");
   if (rootEvent) {
     try { await this.db.createMany("pm_work_notification", recipients.map(recipient => ({ recipient_id: recipient, event_id: rowId(rootEvent), type: "TASK_CREATED", payload: { task_id: taskId, title: task.title }, dedupe_key: `work:${rowId(rootEvent)}:${recipient}`, created_at: this.now }))); }
     catch { console.warn("[work-management] Task save completed; notification delivery pending in outbox."); }
   }
   return result;
  } catch (error) {
   // Compensation is NOT a database rollback. Lost responses or cleanup failures
   // can leave rows behind; report that possibility rather than claiming atomicity.
   let cleaned = true;
   for (const entry of [...journal].reverse().filter(entry => entry.collection !== "pm_work_idempotency")) {
    try { await this.db.remove(entry.collection, entry.ids); } catch { cleaned = false; }
   }
   if (cleaned) { try { await this.db.remove("pm_work_idempotency", [rowId(reservation)]); } catch { cleaned = false; } }
    console.error("[work-management] Task save failed", { taskId, requestId: key, cleanupCompletedForKnownRows: cleaned, error: error instanceof WorkError ? error.code : "NETWORK_OR_UNEXPECTED_ERROR" });
     throw new WorkError(503, "TASK_SAVE_FAILED", `Task save failed. ${cleaned ? "Cleanup of known created rows completed; a lost network response may still require inspection." : "Cleanup was incomplete; inspect this request before retrying."} Request: ${key}`);
  }
 }
}

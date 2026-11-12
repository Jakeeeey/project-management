import { randomUUID, createHash } from "node:crypto";
import type { State, Employee, Task, Occurrence, Workspace, Summary, Detail, OccurrenceView } from "./types";
import { canAssign, canEdit, canRead, assertMutableWorkspace, globalAssignor, requireRule, workspaceAllowed } from "./policies";
import { addDays, localDate, scheduleDates, wallToUtc } from "./recurrence";
import { Amendment, DeadlineInput, ReasonInput, SubmissionInput, TaskInput } from "./schemas";
import { z } from "zod";

const id = () => randomUUID();
export const emptyState = (): State => ({ employees: [], tasks: [], assignments: [], occurrences: [], submissions: [], files: [], events: [], comments: [], acknowledgments: [], notifications: [], outbox: [], idempotency: {} });
export class WorkEngine {
 constructor(public state: State, public actor: Employee, public workspace: Workspace, public now = new Date().toISOString(), private failAudit = false) {
  requireRule(workspaceAllowed(actor, workspace), 403, "FORBIDDEN", "You do not have access to this workspace.");
 }
 private event(type: string, task: Task, occurrence: Occurrence | null, reason: string, old: unknown, next: unknown, request: string, material = false) {
  if (this.failAudit) throw new Error("Simulated audit insert failure");
  const event = { id: id(), event_type: type, task_id: task.id, occurrence_id: occurrence?.id ?? null, actor_id: this.actor.id, reason, old_values: structuredClone(old), new_values: structuredClone(next), created_at: this.now, request_id: request, material };
  this.state.events.push(event);
  const recipients = [...new Set([task.created_by, task.report_to_user_id, ...this.state.assignments.filter(a => a.task_id === task.id && (!occurrence || a.id === occurrence.assignment_id)).map(a => a.assignee_user_id)])];
  this.state.outbox.push({ id: id(), event_id: event.id, recipients, delivered_at: null, attempts: 0 });
  return event;
 }
 deliverOutbox() {
  for (const outbox of this.state.outbox.filter(o => !o.delivered_at)) {
   outbox.attempts++;
   const event = this.state.events.find(e => e.id === outbox.event_id)!;
   for (const recipient of outbox.recipients) {
    if (!this.state.notifications.some(n => n.event_id === event.id && n.recipient_id === recipient)) this.state.notifications.push({ id: id(), recipient_id: recipient, event_id: event.id, type: event.event_type, read_at: null, created_at: this.now });
   }
   outbox.delivered_at = this.now;
  }
 }
 /** In-memory domain command used to validate and shape the corresponding Directus write. */
 command(operation: string, key: string, input: unknown, action: () => unknown): unknown {
  assertMutableWorkspace(this.workspace);
  requireRule(key.length >= 8 && key.length <= 128, 422, "IDEMPOTENCY_REQUIRED", "A valid idempotency key is required.");
  const identity = `${this.actor.id}:${this.workspace}:${operation}:${key}`;
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const prior = this.state.idempotency[identity];
  if (prior) { requireRule(prior.hash === hash, 409, "IDEMPOTENCY_MISMATCH", "This key was used with different input."); return structuredClone(prior.response); }
  const before = this.state; this.state = structuredClone(before);
  try {
   const response = action();
   this.state.idempotency[identity] = { hash, response: structuredClone(response) };
   return response;
  } catch (error) { this.state = before; throw error; }
 }
 task(taskId: string): Task {
  const task = this.state.tasks.find(t => t.id === taskId);
  requireRule(task && (canEdit(this.actor, task) || task.created_by === this.actor.id || task.report_to_user_id === this.actor.id || this.state.assignments.some(a => a.task_id === task.id && canRead(this.actor, task, a, this.workspace))), 404, "NOT_FOUND", "Task not found.");
  return task;
 }
 occurrence(occurrenceId: string): Occurrence {
  const o = this.state.occurrences.find(o => o.id === occurrenceId);
  const task = o && this.state.tasks.find(t => t.id === o.task_id);
  const assignment = o && this.state.assignments.find(a => a.id === o.assignment_id);
  requireRule(o && task && assignment && canRead(this.actor, task, assignment, this.workspace), 404, "NOT_FOUND", "Occurrence not found.");
  return o;
 }
 private editable(task: Task) { requireRule(canEdit(this.actor, task) && this.workspace === "assignor", 403, "FORBIDDEN", "Task editing is not allowed."); requireRule(task.lifecycle_status !== "CANCELLED", 422, "CANCELLED", "Cancelled tasks cannot be changed."); }
 private expected(actual: number, expected: number) { requireRule(actual === expected, 409, "STALE_REVISION", "Someone updated this record. Refresh details before trying again."); }
 private files(fileIds: string[]) {
  requireRule(new Set(fileIds).size === fileIds.length, 422, "DUPLICATE_FILE", "Choose each file once.");
  return fileIds.map(fileId => {
   const f = this.state.files.find(f => f.id === fileId);
   requireRule(f && f.owner_id === this.actor.id && f.state === "VERIFIED" && f.expires_at > this.now, 422, "INVALID_UPLOAD", "File is missing, expired, already claimed, or belongs to someone else."); return f;
  });
 }
 private people(input: z.infer<typeof TaskInput>) {
  requireRule(canAssign(this.actor) && this.workspace === "assignor", 403, "FORBIDDEN", "Assignor capability required.");
  requireRule(globalAssignor(this.actor) || input.scope_type === "DEPARTMENT", 403, "FORBIDDEN", "Global scope requires a global assignor.");
  const department = input.scope_type === "GLOBAL" ? null : globalAssignor(this.actor) ? input.department_id ?? this.actor.department_id : this.actor.department_id;
  const users = [...new Set(input.assignee_user_ids)].map(userId => this.state.employees.find(e => e.id === userId));
  requireRule(users.every(u => u && (department === null || u.department_id === department)), 403, "DEPARTMENT_SCOPE", "Every assignee must belong to the authorized department.");
  const report = input.report_to_user_id || this.actor.id;
  requireRule(this.state.employees.some(e => e.id === report), 422, "INVALID_REPORT_TO", "Report-to employee does not exist.");
  return { department, report, users: users as Employee[] };
 }
 generate(task: Task, request: string, futureOnly = false) {
  if (task.lifecycle_status !== "ACTIVE") return;
  const monthly = task.schedule.frequency === "MONTHLY" || task.schedule.frequency === "CUSTOM" && task.schedule.interval_unit === "MONTH";
  const through = addDays(localDate(this.now, task.schedule.timezone), monthly ? 400 : 60);
  const dates = scheduleDates(task.schedule, through);
  for (const assignment of this.state.assignments.filter(a => a.task_id === task.id && a.status === "ACTIVE")) {
   for (const date of dates) {
    const key = `v${task.schedule_version}:${date}`;
    if (this.state.occurrences.some(o => o.assignment_id === assignment.id && o.occurrence_key === key)) continue;
    const due = wallToUtc(date, task.schedule.due_local_time, task.schedule.timezone);
    if (due < task.schedule_effective_at || futureOnly && due <= this.now) continue;
    // Adding an employee later does not generate retroactive obligations.
    if (due < task.availability_start_at) continue;
    const midnight = wallToUtc(date, "00:00", task.schedule.timezone);
    const available = midnight < task.availability_start_at ? task.availability_start_at : midnight;
    requireRule(available <= due, 422, "INVALID_AVAILABILITY", "Availability is after the deadline.");
    const o: Occurrence = { id: id(), task_id: task.id, assignment_id: assignment.id, occurrence_key: key, scheduled_local_date: date, available_at: available, original_due_at: due, due_at: due, task_revision: structuredClone(task), row_version: 1, status: available > this.now ? "SCHEDULED" : "OPEN", completed_at: null, first_submission_id: null, latest_submission_id: null };
    this.state.occurrences.push(o); this.event("OCCURRENCE_GENERATED", task, o, "Scheduled obligation", null, { due_at: due, occurrence_key: key }, request);
   }
  }
 }
 create(raw: unknown, request: string) {
  const input = TaskInput.parse(raw); const { department, report, users } = this.people(input);
  const references = this.files(input.reference_file_ids);
  requireRule(wallToUtc(input.schedule.start_date, input.schedule.due_local_time, input.schedule.timezone) >= new Date(input.availability_start_at).toISOString(), 422, "INVALID_AVAILABILITY", "The first deadline must be on or after availability.");
  const task: Task = { id: id(), title: input.title, description: input.description, scope_type: input.scope_type, department_id: department, created_by: this.actor.id, report_to_user_id: report, priority: input.priority, availability_start_at: new Date(input.availability_start_at).toISOString(), schedule: input.schedule, schedule_version: 1, schedule_effective_at: new Date(input.availability_start_at).toISOString(), revision_number: 1, lifecycle_status: "ACTIVE", created_at: this.now, reference_file_ids: input.reference_file_ids };
  this.state.tasks.push(task);
  for (const u of users) this.state.assignments.push({ id: id(), task_id: task.id, assignee_user_id: u.id, department_id_at_assignment: u.department_id, status: "ACTIVE" });
  for (const f of references) f.state = "CLAIMED";
  this.event("TASK_CREATED", task, null, "Initial task creation", null, task, request); this.generate(task, request); return task;
 }
 amend(taskId: string, raw: unknown, request: string) {
  const input = Amendment.parse(raw); const task = this.task(taskId); this.editable(task); this.expected(task.revision_number, input.expected_revision);
  const { department, report, users } = this.people(input); const before = structuredClone(task);
  requireRule(input.scope_type === task.scope_type && department === task.department_id, 422, "IMMUTABLE_SCOPE", "Create another task to change ownership scope.");
  const addedReferences = input.reference_file_ids.filter(f => !task.reference_file_ids.includes(f));
  for (const file of this.files(addedReferences)) file.state = "CLAIMED";
  const scheduleChanged = JSON.stringify(task.schedule) !== JSON.stringify(input.schedule);
  Object.assign(task, { title: input.title, description: input.description, priority: input.priority, report_to_user_id: report, schedule: input.schedule, reference_file_ids: input.reference_file_ids, availability_start_at: new Date(input.availability_start_at).toISOString(), revision_number: task.revision_number + 1, schedule_version: task.schedule_version + (scheduleChanged ? 1 : 0), schedule_effective_at: scheduleChanged ? this.now : task.schedule_effective_at });
  for (const assignment of this.state.assignments.filter(a => a.task_id === task.id)) {
   if (!users.some(u => u.id === assignment.assignee_user_id) && assignment.status === "ACTIVE") {
    assignment.status = "ENDED"; this.event("TASK_ASSIGNEE_REMOVED", task, null, input.reason, assignment.assignee_user_id, null, request, true);
   }
  }
  for (const user of users) {
   const assignment = this.state.assignments.find(a => a.task_id === task.id && a.assignee_user_id === user.id);
   requireRule(!assignment || assignment.status === "ACTIVE", 422, "REACTIVATION_UNSUPPORTED", "Ended assignments cannot be reactivated in this version.");
   if (!assignment) { this.state.assignments.push({ id: id(), task_id: task.id, assignee_user_id: user.id, department_id_at_assignment: user.department_id, status: "ACTIVE" }); this.event("TASK_ASSIGNEE_ADDED", task, null, input.reason, null, user.id, request, true); }
  }
  // Only future, unsubmitted instances are reconciled. Past/overdue/completed snapshots stay intact.
  for (const o of this.state.occurrences.filter(o => o.task_id === task.id && !o.first_submission_id && o.due_at > this.now && o.status !== "CANCELLED")) {
   const active = this.state.assignments.find(a => a.id === o.assignment_id)?.status === "ACTIVE";
   if (scheduleChanged || !active) { o.status = "CANCELLED"; o.row_version++; this.event("OCCURRENCE_CANCELLED", task, o, input.reason, { due_at: o.due_at }, { status: o.status }, request, true); }
   else { o.task_revision = structuredClone(task); o.row_version++; }
  }
  this.event(scheduleChanged ? "TASK_SCHEDULE_CHANGED" : "TASK_DETAILS_UPDATED", task, null, input.reason, before, task, request, true);
  this.generate(task, request, true); return task;
 }
 lifecycle(taskId: string, action: string, raw: unknown, request: string) {
  const input = ReasonInput.parse(raw); const task = this.task(taskId); this.editable(task); this.expected(task.revision_number, input.expected_revision);
  requireRule(action === "cancel" || action === "pause" && task.lifecycle_status === "ACTIVE" || action === "resume" && task.lifecycle_status === "PAUSED", 422, "INVALID_TRANSITION", "Invalid lifecycle transition.");
  const before = task.lifecycle_status; task.lifecycle_status = action === "cancel" ? "CANCELLED" : action === "pause" ? "PAUSED" : "ACTIVE"; task.revision_number++;
  if (action === "cancel") for (const o of this.state.occurrences.filter(o => o.task_id === task.id && !o.first_submission_id && o.status !== "CANCELLED")) { o.status = "CANCELLED"; o.row_version++; this.event("OCCURRENCE_CANCELLED", task, o, input.reason, null, { status: "CANCELLED" }, request, true); }
  this.event(action === "cancel" ? "TASK_CANCELLED" : action === "pause" ? "TASK_PAUSED" : "TASK_RESUMED", task, null, input.reason, before, task.lifecycle_status, request, true);
  if (action === "resume") this.generate(task, request); return task;
 }
 changeAssignments(taskId: string, users: string[], raw: unknown, request: string) {
  const input = ReasonInput.parse(raw); const task = this.task(taskId);
  requireRule(users.length > 0, 422, "ASSIGNEE_REQUIRED", "At least one active assignee must remain.");
  return this.amend(taskId, { ...task, department_id: task.department_id ?? undefined, assignee_user_ids: users, expected_revision: input.expected_revision, reason: input.reason }, request);
 }
 deadline(occurrenceId: string, raw: unknown, request: string) {
  const input = DeadlineInput.parse(raw); const o = this.occurrence(occurrenceId); const task = this.task(o.task_id); this.editable(task); this.expected(o.row_version, input.expected_revision);
  requireRule(!o.first_submission_id && o.status !== "CANCELLED", 422, "IMMUTABLE_HISTORY", "Completed/cancelled deadlines cannot be changed.");
  requireRule(new Date(input.due_at).toISOString() >= o.available_at, 422, "INVALID_DEADLINE", "Deadline precedes availability.");
  const old = o.due_at; o.due_at = new Date(input.due_at).toISOString(); o.row_version++;
  this.event("TASK_DEADLINE_CHANGED", task, o, input.reason, { due_at: old }, { due_at: o.due_at }, request, true); return o;
 }
 cancelOccurrence(occurrenceId: string, raw: unknown, request: string) {
  const input = ReasonInput.parse(raw); const o = this.occurrence(occurrenceId); const task = this.task(o.task_id); this.editable(task); this.expected(o.row_version, input.expected_revision);
  requireRule(!o.first_submission_id && o.status !== "CANCELLED", 422, "INVALID_TRANSITION", "Only unsubmitted open occurrences can be cancelled.");
  o.status = "CANCELLED"; o.row_version++; this.event("OCCURRENCE_CANCELLED", task, o, input.reason, null, { status: o.status }, request, true); return o;
 }
 submit(occurrenceId: string, raw: unknown, request: string) {
  const input = SubmissionInput.parse(raw); const o = this.occurrence(occurrenceId); this.expected(o.row_version, input.expected_revision);
  const assignment = this.state.assignments.find(a => a.id === o.assignment_id)!;
  requireRule(assignment.assignee_user_id === this.actor.id && this.workspace === "my-tasks", 403, "OWN_SUBMISSION_ONLY", "Only the assignee may submit from My Tasks.");
  requireRule(o.status !== "CANCELLED" && o.available_at <= this.now, 422, "NOT_AVAILABLE", "This occurrence is not available for submission.");
  const files = this.files(input.file_upload_ids); const versions = this.state.submissions.filter(s => s.occurrence_id === o.id);
   // Submission requires deliverable files. Remarks/revision explanations are optional.
  const submission = { id: id(), occurrence_id: o.id, version_number: versions.length + 1, submitted_by: this.actor.id, submitted_at: this.now, evaluated_due_at: o.due_at, is_late: this.now > o.due_at, remark: input.remark, revision_reason: input.revision_reason, file_ids: input.file_upload_ids };
  for (const file of files) file.state = "CLAIMED";
  this.state.submissions.push(submission);
  if (!o.first_submission_id) { o.first_submission_id = submission.id; o.completed_at = this.now; }
  o.latest_submission_id = submission.id; o.status = "COMPLETED"; o.row_version++;
   this.event(versions.length ? "SUBMISSION_REVISED" : "SUBMISSION_CREATED", this.task(o.task_id), o, versions.length ? "Deliverable version resubmitted" : "Deliverable submitted", null, { version: submission.version_number, is_late: submission.is_late, evaluated_due_at: o.due_at }, request); return submission;
 }
 comment(occurrenceId: string, raw: unknown, request: string) {
  const input = z.object({ text: z.string().trim().min(1).max(10000), submission_id: z.string().optional() }).parse(raw);
  const o = this.occurrence(occurrenceId); const task = this.task(o.task_id); const a = this.state.assignments.find(a => a.id === o.assignment_id)!;
  requireRule([task.created_by, task.report_to_user_id, a.assignee_user_id].includes(this.actor.id), 403, "FORBIDDEN", "Only creator, report-to or assignee may comment.");
  requireRule(!input.submission_id || this.state.submissions.some(s => s.id === input.submission_id && s.occurrence_id === o.id), 404, "NOT_FOUND", "Submission not found.");
  const comment = { id: id(), occurrence_id: o.id, submission_id: input.submission_id ?? null, author_id: this.actor.id, text: input.text, created_at: this.now };
  this.state.comments.push(comment); this.event("SUBMISSION_COMMENTED", task, o, "Discussion comment", null, { comment_id: comment.id }, request); return comment;
 }
 acknowledge(occurrenceId: string, raw: unknown, request: string) {
  const input = z.object({ event_id: z.string() }).parse(raw); const o = this.occurrence(occurrenceId);
  requireRule(this.state.assignments.some(a => a.id === o.assignment_id && a.assignee_user_id === this.actor.id), 403, "FORBIDDEN", "Only the assignee may acknowledge.");
  const event = this.state.events.find(e => e.id === input.event_id && e.task_id === o.task_id && (!e.occurrence_id || e.occurrence_id === o.id) && e.material);
  requireRule(event, 404, "NOT_FOUND", "Change event not found.");
  if (!this.state.acknowledgments.some(a => a.occurrence_id === o.id && a.event_id === event.id && a.user_id === this.actor.id)) {
   this.state.acknowledgments.push({ occurrence_id: o.id, event_id: event.id, user_id: this.actor.id });
   this.event("TASK_CHANGE_ACKNOWLEDGED", this.task(o.task_id), o, "Read receipt, not agreement", null, { event_id: event.id }, request);
  }
  return { acknowledged: true };
 }
  list(from: string, to: string, employee?: string): OccurrenceView[] {
  return this.state.occurrences.flatMap(o => {
   const task = this.state.tasks.find(t => t.id === o.task_id)!; const assignment = this.state.assignments.find(a => a.id === o.assignment_id)!;
   const assignee = this.state.employees.find(e => e.id === assignment.assignee_user_id)!;
   const date = localDate(o.due_at);
    if (!canRead(this.actor, task, assignment, this.workspace) || date < from || date > to || employee && employee !== assignee.id) return [];
   return [{ ...o, task, assignee, submissions: this.state.submissions.filter(s => s.occurrence_id === o.id) }];
  }).sort((a, b) => a.due_at.localeCompare(b.due_at));
 }
 summary(from: string, to: string, employee?: string): Summary {
  const all = this.list("1900-01-01", to, employee).filter(o => o.status !== "CANCELLED");
  const period = all.filter(o => localDate(o.due_at) >= from);
  return { due: period.length, submitted: period.filter(o => o.first_submission_id).length, on_time: period.filter(o => o.submissions.some(s => s.id === o.first_submission_id && !s.is_late)).length, overdue: period.filter(o => !o.first_submission_id && o.due_at < this.now).length, backlog: all.filter(o => localDate(o.due_at) < from && !o.first_submission_id && o.due_at < this.now).length };
 }
 detail(occurrenceId: string): Detail {
  const o = this.occurrence(occurrenceId); const task = this.task(o.task_id); const a = this.state.assignments.find(a => a.id === o.assignment_id)!;
  const submissions = this.state.submissions.filter(s => s.occurrence_id === o.id);
  const events = this.state.events.filter(e => e.task_id === task.id && (!e.occurrence_id || e.occurrence_id === o.id));
  const fileIds = [...o.task_revision.reference_file_ids, ...submissions.flatMap(s => s.file_ids)];
  return { ...o, task, assignee: this.state.employees.find(u => u.id === a.assignee_user_id)!, submissions, events, comments: this.state.comments.filter(c => c.occurrence_id === o.id), files: this.state.files.filter(f => fileIds.includes(f.id)).map(f => ({ id: f.id, owner_id: f.owner_id, name: f.name, mime: f.mime, size: f.size, sha256: f.sha256, expires_at: f.expires_at, state: f.state })), unacknowledged: a.assignee_user_id !== this.actor.id ? [] : events.filter(e => e.material && !this.state.acknowledgments.some(ack => ack.occurrence_id === o.id && ack.event_id === e.id && ack.user_id === this.actor.id)), can_edit: this.workspace === "assignor" && canEdit(this.actor, task) && task.lifecycle_status !== "CANCELLED", can_submit: this.workspace === "my-tasks" && a.assignee_user_id === this.actor.id && o.status !== "CANCELLED" && o.available_at <= this.now, can_comment: this.workspace !== "executive" && [a.assignee_user_id, task.created_by, task.report_to_user_id].includes(this.actor.id) };
 }
}

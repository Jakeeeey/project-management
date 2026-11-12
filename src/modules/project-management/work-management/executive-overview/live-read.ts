import type { Assignment, Employee, Occurrence, Schedule, Submission, Task, WorkFile, Workspace } from "./types";
import { emptyState, WorkEngine } from "./engine";
import { requireRule, workspaceAllowed, WorkError } from "./policies";
import { addDays, localDate, wallToUtc } from "./recurrence";
import { isActiveEmployeeFlag } from "./employee-policy";

type Row = Record<string, unknown>;
export type ReadCollection = (collection: string, fields: string[], filter: Record<string, unknown>, limit: number, page?: number) => Promise<Row[]>;
export interface ReadPeriod { from: string; to: string; page: number; limit: number; employee?: string }
const id = (value: unknown) => {
<<<<<<< HEAD
 requireRule(typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value), 502, "INVALID_DATABASE_ID", "The stored record has an invalid identifier.");
=======
 requireRule(typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value), 502, "INVALID_DATABASE_ID", "Directus returned an invalid or unsafe identifier.");
>>>>>>> origin
 return String(value);
};
const utc = (value: unknown): string => {
 const text = String(value).replace(" ", "T");
 const instant = new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : text + "Z");
 requireRule(Number.isFinite(instant.getTime()), 502, "INVALID_DATABASE_DATE", "A stored Work Management timestamp is invalid.");
 return instant.toISOString();
};
const json = (value: unknown): Row => {
 const parsed = typeof value === "string" ? JSON.parse(value) : value;
 return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
};

/** GET-only repository. Scope is applied before loading rows, never in the browser. */
export class LiveReader {
 constructor(private read: ReadCollection, private now = new Date().toISOString()) {}
 private async all(collection: string, fields: string[], filter: Row): Promise<Row[]> {
  const result: Row[] = [];
  for (let page = 1; page <= 21; page++) {
   const batch = await this.read(collection, fields, filter, 250, page);
   result.push(...batch);
   requireRule(result.length <= 5000, 422, "READ_LIMIT", "This scope exceeds 5,000 records. Narrow the reporting period or employee filter.");
   if (batch.length < 250) return result;
  }
  throw new WorkError(422, "READ_LIMIT", "Narrow the reporting scope.");
 }
 private async byIds(collection: string, fields: string[], field: string, ids: string[]): Promise<Row[]> {
  const unique = [...new Set(ids)]; const result: Row[] = [];
  for (let index = 0; index < unique.length; index += 100) result.push(...await this.all(collection, fields, { [field]: { _in: unique.slice(index, index + 100) } }));
  return result;
 }
 async directory(actor: Employee, workspace: Workspace): Promise<Employee[]> {
  requireRule(workspaceAllowed(actor, workspace), 403, "FORBIDDEN", "You do not have access to this workspace.");
  if (workspace === "my-tasks") return [actor];
  const allDepartments = workspace === "executive" || actor.roles.includes("GLOBAL_ASSIGNOR") || actor.read_all_departments === true;
  const filter = allDepartments ? {} : actor.department_id ? { user_department: { _eq: actor.department_id } } : { user_id: { _eq: actor.id } };
  const users = (await this.all("user", ["user_id", "user_fname", "user_lname", "user_department", "is_deleted"], filter)).filter(user => isActiveEmployeeFlag(user.is_deleted));
  const departments = await this.byIds("department", ["department_id", "department_name"], "department_id", users.filter(user => user.user_department !== null).map(user => id(user.user_department)));
  return users.map(user => ({
   id: id(user.user_id), name: [user.user_fname, user.user_lname].filter(Boolean).join(" "),
   department_id: user.user_department === null ? "" : id(user.user_department),
   department: String(departments.find(department => String(department.department_id) === String(user.user_department))?.department_name ?? "No department"),
   roles: id(user.user_id) === actor.id ? actor.roles : [],
  }));
 }
 async detail(actor: Employee, workspace: Workspace, occurrenceId: string) {
  requireRule(workspaceAllowed(actor, workspace), 403, "FORBIDDEN", "You do not have access to this workspace.");
  requireRule(/^\d+$/.test(occurrenceId), 404, "NOT_FOUND", "Occurrence not found.");
  const row = (await this.read("pm_work_occurrence", ["id", "due_at", "task_revision_id"], { id: { _eq: occurrenceId } }, 1))[0];
  requireRule(row, 404, "NOT_FOUND", "Occurrence not found.");
  const date = localDate(utc(row.due_at));
  const period = { from: date, to: date, page: 1, limit: 100 };
  let engine = await this.load(actor, workspace, period);
<<<<<<< HEAD
  if (!engine.state.occurrences.some(o => o.id === occurrenceId) && workspace === "my-tasks") engine = await this.load(actor, workspace, period);
=======
  if (!engine.state.occurrences.some(o => o.id === occurrenceId) && workspace === "my-tasks") engine = await this.load(actor, workspace, period, true);
>>>>>>> origin
  const occurrence = engine.occurrence(occurrenceId); // Authorize before exposing files/history.
  const submissions = engine.state.submissions.filter(s => s.occurrence_id === occurrenceId);
  const [files, references, events, comments] = await Promise.all([
   this.byIds("pm_work_submission_file", ["*"], "submission_id", submissions.map(s => s.id)),
   this.all("pm_work_task_reference_file", ["*"], { task_id: { _eq: occurrence.task_id }, task_revision_id: { _eq: row.task_revision_id } }),
   this.all("pm_work_audit_event", ["*"], { task_id: { _eq: occurrence.task_id }, _or: [{ occurrence_id: { _eq: occurrenceId } }, { occurrence_id: { _null: true } }] }),
   this.all("pm_work_comment", ["*"], { occurrence_id: { _eq: occurrenceId } }),
  ]);
  const metadata = (file: Row, fileId: string, owner: string): WorkFile => ({ id: fileId, owner_id: owner, name: String(file.original_filename), mime: String(file.mime_type), size: Number(file.size_bytes), sha256: String(file.sha256 ?? ""), expires_at: this.now, state: "CLAIMED", bytes: "" });
  for (const file of files) {
   const submission = submissions.find(s => s.id === id(file.submission_id))!;
   const fileId = `submission:${id(file.id)}`;
   submission.file_ids.push(fileId); engine.state.files.push(metadata(file, fileId, submission.submitted_by));
  }
  for (const file of references) {
   const fileId = `reference:${id(file.id)}`;
   occurrence.task_revision.reference_file_ids.push(fileId); engine.state.files.push(metadata(file, fileId, id(file.added_by)));
  }
  const decode = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value ?? null;
<<<<<<< HEAD
   engine.state.events = events.map(event => ({ id: id(event.id), event_type: String(event.event_type), task_id: id(event.task_id), occurrence_id: event.occurrence_id ? id(event.occurrence_id) : null, actor_id: event.actor_id ? id(event.actor_id) : String(event.system_actor ?? "System"), reason: String(event.reason ?? ""), old_values: decode(event.old_values), new_values: decode(event.new_values), created_at: utc(event.created_at), request_id: String(event.request_id), material: /^(TASK_(DETAILS_UPDATED|SCHEDULE_CHANGED|PAUSED|RESUMED|CANCELLED|ARCHIVED|DEADLINE_CHANGED)|OCCURRENCE_(REVIEWED|MARKED_DONE|DEADLINE_CHANGED|CANCELLED))$/.test(String(event.event_type)) })).sort((a, b) => a.created_at.localeCompare(b.created_at));
=======
  engine.state.events = events.map(event => ({ id: id(event.id), event_type: String(event.event_type), task_id: id(event.task_id), occurrence_id: event.occurrence_id ? id(event.occurrence_id) : null, actor_id: event.actor_id ? id(event.actor_id) : String(event.system_actor ?? "System"), reason: String(event.reason ?? ""), old_values: decode(event.old_values), new_values: decode(event.new_values), created_at: utc(event.created_at), request_id: String(event.request_id), material: false })).sort((a, b) => a.created_at.localeCompare(b.created_at));
>>>>>>> origin
  engine.state.comments = comments.map(comment => ({ id: id(comment.id), occurrence_id: id(comment.occurrence_id), submission_id: comment.submission_id ? id(comment.submission_id) : null, author_id: id(comment.author_id), text: String(comment.comment_text), created_at: utc(comment.created_at) }));
  const detail = engine.detail(occurrenceId);
  // Persisted create/read testing is enabled; edit/submit/comment commands and
  // acknowledgment writes are intentionally not implied by enabling Create Task.
   return { ...detail, can_edit: false, can_submit: detail.can_submit && workspace === "my-tasks", can_comment: false, unacknowledged: [] };
 }
<<<<<<< HEAD
  async load(actor: Employee, workspace: Workspace, period: ReadPeriod): Promise<WorkEngine> {
  requireRule(workspaceAllowed(actor, workspace), 403, "FORBIDDEN", "You do not have access to this workspace.");
  const state = emptyState();
  let assignmentFilter: Row;
   if (workspace === "my-tasks") assignmentFilter = { assignee_user_id: { _eq: actor.id } };
   else if (workspace === "departmental") assignmentFilter = { department_id_at_assignment: { _eq: actor.department_id } };
   else if (workspace === "executive" || actor.roles.includes("GLOBAL_ASSIGNOR") || actor.read_all_departments === true) assignmentFilter = {};
  else assignmentFilter = actor.department_id ? { department_id_at_assignment: { _eq: actor.department_id } } : { assignee_user_id: { _eq: actor.id } };
  if (period.employee) {
    requireRule(workspace !== "my-tasks" || period.employee === actor.id, 403, "OWN_TASKS_ONLY", "My Tasks only shows your own obligations.");
=======
 async load(actor: Employee, workspace: Workspace, period: ReadPeriod, review = false): Promise<WorkEngine> {
  requireRule(workspaceAllowed(actor, workspace), 403, "FORBIDDEN", "You do not have access to this workspace.");
  const state = emptyState();
  let assignmentFilter: Row;
  if (workspace === "my-tasks" && !review) assignmentFilter = { assignee_user_id: { _eq: actor.id } };
  else if (review) {
   const tasks = await this.all("pm_work_task", ["id"], { _or: [{ created_by: { _eq: actor.id } }, { report_to_user_id: { _eq: actor.id } }] });
   assignmentFilter = { task_id: { _in: tasks.map(t => id(t.id)) } };
   if (!tasks.length) { state.employees = [actor]; return new WorkEngine(state, actor, workspace, this.now); }
  } else if (workspace === "executive" || actor.roles.includes("GLOBAL_ASSIGNOR") || actor.read_all_departments === true) assignmentFilter = {};
  else assignmentFilter = actor.department_id ? { department_id_at_assignment: { _eq: actor.department_id } } : { assignee_user_id: { _eq: actor.id } };
  if (period.employee) {
   requireRule(workspace !== "my-tasks" || review || period.employee === actor.id, 403, "OWN_TASKS_ONLY", "My Tasks only shows your own obligations.");
>>>>>>> origin
   assignmentFilter = { _and: [assignmentFilter, { assignee_user_id: { _eq: period.employee } }] };
  }
  const assignments = await this.all("pm_work_assignment", ["id", "task_id", "assignee_user_id", "department_id_at_assignment", "status"], assignmentFilter);
  state.assignments = assignments.map(a => ({ id: id(a.id), task_id: id(a.task_id), assignee_user_id: id(a.assignee_user_id), department_id_at_assignment: id(a.department_id_at_assignment), status: a.status as Assignment["status"] }));
  const from = wallToUtc(period.from, "00:00", "Asia/Manila"), until = wallToUtc(addDays(period.to, 1), "00:00", "Asia/Manila");
  const occurrenceRows: Row[] = [];
  for (let start = 0; start < assignments.length; start += 100) {
   occurrenceRows.push(...await this.all("pm_work_occurrence", ["id", "task_id", "assignment_id", "task_revision_id", "occurrence_key", "scheduled_local_date", "available_at", "original_due_at", "due_at", "row_version", "status", "completed_at", "first_submission_id", "latest_submission_id"], {
    _and: [{ assignment_id: { _in: assignments.slice(start, start + 100).map(a => id(a.id)) } }, { due_at: { _lt: until } }, { _or: [{ due_at: { _gte: from } }, { _and: [{ first_submission_id: { _null: true } }, { status: { _neq: "CANCELLED" } }] }] }],
   }));
  }
  requireRule(occurrenceRows.length <= 5000, 422, "READ_LIMIT", "Too many obligations. Narrow the reporting scope.");
  const taskIds = state.assignments.map(a => a.task_id);
<<<<<<< HEAD
   const [tasks, schedules, revisions, taskRevisions] = await Promise.all([
    this.byIds("pm_work_task", ["*"], "id", taskIds),
    this.byIds("pm_work_recurrence", ["*"], "task_id", taskIds),
    this.byIds("pm_work_task_revision", ["id", "task_id", "revision_number", "snapshot"], "id", occurrenceRows.map(o => id(o.task_revision_id))),
    this.byIds("pm_work_task_revision", ["id", "task_id", "revision_number", "snapshot"], "task_id", taskIds),
=======
  const [tasks, schedules, revisions] = await Promise.all([
   this.byIds("pm_work_task", ["*"], "id", taskIds),
   this.byIds("pm_work_recurrence", ["*"], "task_id", taskIds),
   this.byIds("pm_work_task_revision", ["id", "task_id", "revision_number", "snapshot"], "id", occurrenceRows.map(o => id(o.task_revision_id))),
>>>>>>> origin
  ]);
  const scheduleFor = (taskId: string): Schedule => {
   const row = schedules.filter(s => id(s.task_id) === taskId).sort((a, b) => Number(b.schedule_version) - Number(a.schedule_version))[0];
   requireRule(row, 502, "MISSING_SCHEDULE", "A task is missing its recurrence definition.");
   const weekdays = typeof row.days_of_week === "string" ? JSON.parse(row.days_of_week) : row.days_of_week;
   return { frequency: row.frequency as Schedule["frequency"], interval_value: Number(row.interval_value), interval_unit: row.interval_unit as Schedule["interval_unit"] ?? undefined, days_of_week: Array.isArray(weekdays) ? weekdays : [], day_of_month: row.day_of_month === null ? undefined : Number(row.day_of_month), month_end_policy: row.month_end_policy as Schedule["month_end_policy"], due_local_time: String(row.due_local_time), timezone: String(row.timezone), start_date: String(row.start_date).slice(0, 10), end_date: row.end_date ? String(row.end_date).slice(0, 10) : undefined, until_count: row.until_count ? Number(row.until_count) : undefined };
  };
  state.tasks = tasks.map(t => ({ id: id(t.id), title: String(t.title), description: String(t.description), scope_type: t.scope_type as Task["scope_type"], department_id: t.department_id === null ? null : id(t.department_id), created_by: id(t.created_by), report_to_user_id: id(t.report_to_user_id), priority: t.priority as Task["priority"], availability_start_at: utc(t.availability_start_at), schedule: scheduleFor(id(t.id)), schedule_version: Number(schedules.filter(s => id(s.task_id) === id(t.id)).reduce((v, s) => Math.max(v, Number(s.schedule_version)), 1)), schedule_effective_at: utc(t.availability_start_at), revision_number: Number(t.revision_number), lifecycle_status: t.lifecycle_status as Task["lifecycle_status"], created_at: utc(t.created_at), reference_file_ids: [] }));
  state.occurrences = occurrenceRows.map(o => {
   const current = state.tasks.find(t => t.id === id(o.task_id));
<<<<<<< HEAD
    const currentRevision = taskRevisions.filter(r => id(r.task_id) === id(o.task_id)).sort((a, b) => Number(b.revision_number) - Number(a.revision_number))[0];
    const useCurrentRevision = !o.first_submission_id && o.status !== "CANCELLED" && utc(o.due_at) > this.now && currentRevision;
    const revision = useCurrentRevision ? currentRevision : revisions.find(r => id(r.id) === id(o.task_revision_id));
=======
   const revision = revisions.find(r => id(r.id) === id(o.task_revision_id));
>>>>>>> origin
   requireRule(current && revision && id(revision.task_id) === current.id, 502, "MISSING_TASK_REVISION", "An obligation is missing its historical task revision.");
   const snapshot = json(revision.snapshot);
   // Only historical presentation fields are taken from a snapshot. Authorization
   // always uses the current authoritative task/assignment, never JSON-supplied IDs.
<<<<<<< HEAD
    const historical: Task = { ...current, title: typeof snapshot.title === "string" ? snapshot.title : current.title, description: typeof snapshot.description === "string" ? snapshot.description : current.description, priority: (snapshot.priority ?? current.priority) as Task["priority"], report_to_user_id: typeof snapshot.report_to_user_id === "string" ? snapshot.report_to_user_id : current.report_to_user_id, availability_start_at: typeof snapshot.availability_start_at === "string" ? snapshot.availability_start_at : current.availability_start_at, schedule: snapshot.schedule && typeof snapshot.schedule === "object" ? snapshot.schedule as Schedule : current.schedule, schedule_version: Number(snapshot.schedule_version ?? current.schedule_version), schedule_effective_at: typeof snapshot.schedule_effective_at === "string" ? snapshot.schedule_effective_at : current.schedule_effective_at, reference_file_ids: Array.isArray(snapshot.reference_file_ids) ? snapshot.reference_file_ids as string[] : current.reference_file_ids, revision_number: Number(revision.revision_number) };
   return { id: id(o.id), task_id: id(o.task_id), assignment_id: id(o.assignment_id), occurrence_key: String(o.occurrence_key), scheduled_local_date: String(o.scheduled_local_date).slice(0, 10), available_at: utc(o.available_at), original_due_at: utc(o.original_due_at), due_at: utc(o.due_at), row_version: Number(o.row_version), task_revision: historical, status: o.status as Occurrence["status"], completed_at: o.completed_at ? utc(o.completed_at) : null, first_submission_id: o.first_submission_id ? id(o.first_submission_id) : null, latest_submission_id: o.latest_submission_id ? id(o.latest_submission_id) : null };
  });
   const peopleIds = [actor.id, ...state.assignments.map(a => a.assignee_user_id), ...state.tasks.flatMap(t => [t.created_by, t.report_to_user_id])];
<<<<<<<< HEAD:src/modules/project-management/work-management/executive-overview/live-read.ts
   const directoryScope = workspace === "departmental" ? { user_department: { _eq: actor.department_id } } : workspace === "executive" || actor.roles.includes("GLOBAL_ASSIGNOR") || actor.read_all_departments === true ? {} : actor.department_id ? { user_department: { _eq: actor.department_id } } : { user_id: { _eq: actor.id } };
========
   const directoryScope = workspace === "executive" || actor.roles.includes("GLOBAL_ASSIGNOR") || actor.read_all_departments === true ? {} : actor.department_id ? { user_department: { _eq: actor.department_id } } : { user_id: { _eq: actor.id } };
>>>>>>>> origin:src/modules/project-management/work-management/assignment-center/live-read.ts
=======
   const historical: Task = { ...current, title: typeof snapshot.title === "string" ? snapshot.title : current.title, description: typeof snapshot.description === "string" ? snapshot.description : current.description, priority: (snapshot.priority ?? current.priority) as Task["priority"], revision_number: Number(revision.revision_number) };
   return { id: id(o.id), task_id: id(o.task_id), assignment_id: id(o.assignment_id), occurrence_key: String(o.occurrence_key), scheduled_local_date: String(o.scheduled_local_date).slice(0, 10), available_at: utc(o.available_at), original_due_at: utc(o.original_due_at), due_at: utc(o.due_at), row_version: Number(o.row_version), task_revision: historical, status: o.status as Occurrence["status"], completed_at: o.completed_at ? utc(o.completed_at) : null, first_submission_id: o.first_submission_id ? id(o.first_submission_id) : null, latest_submission_id: o.latest_submission_id ? id(o.latest_submission_id) : null };
  });
   const peopleIds = [actor.id, ...state.assignments.map(a => a.assignee_user_id), ...state.tasks.flatMap(t => [t.created_by, t.report_to_user_id])];
   const directoryScope = workspace === "executive" || actor.roles.includes("GLOBAL_ASSIGNOR") || actor.read_all_departments === true ? {} : actor.department_id ? { user_department: { _eq: actor.department_id } } : { user_id: { _eq: actor.id } };
>>>>>>> origin
   const [submissions, users, directory] = await Promise.all([
    this.byIds("pm_work_submission", ["*"], "occurrence_id", state.occurrences.map(o => o.id)),
    this.byIds("user", ["user_id", "user_fname", "user_lname", "user_department", "is_deleted"], "user_id", peopleIds),
    workspace === "my-tasks" ? Promise.resolve([]) : this.all("user", ["user_id", "user_fname", "user_lname", "user_department", "is_deleted"], directoryScope),
   ]);
   state.submissions = submissions.map(s => ({ id: id(s.id), occurrence_id: id(s.occurrence_id), version_number: Number(s.version_number), submitted_by: id(s.submitted_by), submitted_at: utc(s.submitted_at), evaluated_due_at: utc(s.evaluated_due_at), is_late: s.is_late === true || s.is_late === 1 || s.is_late === "1", remark: String(s.remark ?? ""), revision_reason: String(s.revision_reason ?? ""), file_ids: [] } satisfies Submission));
   const directoryIds = directory.filter(u => isActiveEmployeeFlag(u.is_deleted)).map(u => id(u.user_id));
   const allUsers = [...users];
   for (const userId of directoryIds) if (!allUsers.some(u => id(u.user_id) === userId)) {
    const row = directory.find(u => id(u.user_id) === userId);
    if (row) allUsers.push(row);
   }
   const departments = await this.byIds("department", ["department_id", "department_name"], "department_id", allUsers.filter(u => u.user_department !== null).map(u => id(u.user_department)));
   state.employees = allUsers.map(u => ({ id: id(u.user_id), name: [u.user_fname, u.user_lname].filter(Boolean).join(" "), department_id: u.user_department === null ? "" : id(u.user_department), department: departments.find(d => String(d.department_id) === String(u.user_department))?.department_name as string ?? "No department", roles: id(u.user_id) === actor.id ? actor.roles : [] }));
  if (!state.employees.some(e => e.id === actor.id)) state.employees.push(actor);
   // Include active employees with zero obligations from the directory fetched in parallel.
   for (const u of directory.filter(u => isActiveEmployeeFlag(u.is_deleted))) if (!state.employees.some(e => e.id === id(u.user_id))) state.employees.push({ id: id(u.user_id), name: [u.user_fname, u.user_lname].filter(Boolean).join(" "), department_id: u.user_department === null ? "" : id(u.user_department), department: departments.find(d => String(d.department_id) === String(u.user_department))?.department_name as string ?? "No department", roles: [] });
  return new WorkEngine(state, actor, workspace, this.now);
 }
}

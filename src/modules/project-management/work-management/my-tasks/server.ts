import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { COOKIE_NAME, decodeJwtPayload } from "@/lib/auth-utils";
import { requireRule, WorkError, workspaceAllowed } from "./policies";
import type { Bootstrap, Employee, Role, Workspace } from "./types";
import { isActiveEmployeeFlag } from "./employee-policy";
import { LiveReader, type ReadPeriod } from "./live-read";
import { addDays, localDate, parseUtcTimestamp } from "./recurrence";
import { resolveWorkspaceReadAccess } from "./workspace-access";
import { DirectusClient } from "./directus-client";
import { TaskWriter } from "./task-writer";
import { SubmissionInput } from "./schemas";

/** New module verifies with the issuer independently of legacy middleware coverage. */
export async function verifiedActor() {
 const token = (await cookies()).get(COOKIE_NAME)?.value;
 requireRule(token, 401, "UNAUTHENTICATED", "Sign in to continue.");
 const base = process.env.SPRING_API_BASE_URL?.replace(/\/+$/, "");
 requireRule(base, 503, "AUTH_UNAVAILABLE", "Authentication service is not configured.");
 let response: Response;
 try { response = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(5000) }); }
 catch { throw new WorkError(503, "AUTH_UNAVAILABLE", "Unable to verify your session."); }
 requireRule(response.ok, response.status === 401 || response.status === 403 ? 401 : 503, "AUTH_VERIFICATION_FAILED", "The authentication service did not validate this session.");
 const payload = decodeJwtPayload(token);
 const userId = [payload?.id, payload?.user_id, payload?.sub].find(v => /^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v) > 0);
 requireRule(userId, 401, "INVALID_IDENTITY", "No usable employee identity in the verified session.");
 return { userId: String(userId), token };
}

async function readRows<T>(collection: string, fields: string[], filter: Record<string, unknown>, limit = 100, page = 1): Promise<T[]> {
 const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");
 const token = process.env.DIRECTUS_STATIC_TOKEN;
 requireRule(base && token, 503, "DATA_SOURCE_NOT_CONFIGURED", "Work Management data configuration is missing.");
 const sort = collection === "user" ? "user_id" : collection === "department" ? "department_id" : "id";
 const query = new URLSearchParams({ fields: fields.join(","), filter: JSON.stringify(filter), limit: String(limit), page: String(page), sort });
 const response = await fetch(`${base}/items/${collection}?${query}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(10000) });
 requireRule(response.ok, 503, "DATA_SOURCE_UNAVAILABLE", "Unable to load Work Management data.");
 const body = await response.json(); return body.data as T[];
}

/** Live capability bootstrap reads only authoritative employee/explicit grant rows. */
export async function liveBootstrap(): Promise<Bootstrap> {
 const { userId } = await verifiedActor();
  const [users, grants, modules] = await Promise.all([
   readRows<{ user_id: number; user_fname: string; user_lname: string; user_department: number | null; is_deleted: unknown; role: unknown; isAdmin: unknown }>("user", ["user_id", "user_fname", "user_lname", "user_department", "is_deleted", "role", "isAdmin"], { user_id: { _eq: userId } }, 1),
   readRows<{ role: Role; department_id: number | null }>("pm_work_role_grant", ["role", "department_id"], { user_id: { _eq: userId }, revoked_at: { _null: true } }),
   readRows<{ id: number | string; base_path: string }>("modules", ["id", "base_path"], { status: { _eq: "active" }, base_path: { _in: ["/project-management/work-management/assignor", "/project-management/work-management/assignment-center", "/project-management/work-management/assignee", "/project-management/work-management/my-tasks", "/project-management/work-management/executive", "/project-management/work-management/executive-overview"] } }),
  ]);
  requireRule(users.length && isActiveEmployeeFlag(users[0].is_deleted), 401, "INACTIVE_EMPLOYEE", "Your employee record is unavailable.");
 const user = users[0];
 // The initial UI only supports the actor's home-department assignor scope. Other
 // department grants are not broadened silently; multi-department selection is a live blocker.
  const roles = [...new Set(grants.filter(g => g.role !== "DEPARTMENT_ASSIGNOR" || String(g.department_id) === String(user.user_department)).map(g => g.role))];
  const [moduleGrants, departments] = await Promise.all([
   modules.length ? readRows<{ module_id: number | string }>("user_access_modules", ["module_id"], { user_id: { _eq: userId }, module_id: { _in: modules.map(m => m.id) } }) : Promise.resolve([]),
   user.user_department === null ? Promise.resolve([]) : readRows<{ department_name: string }>("department", ["department_name"], { department_id: { _eq: user.user_department } }, 1),
  ]);
 const grantedIds = new Set(moduleGrants.map(grant => String(grant.module_id)));
 const readAccess = resolveWorkspaceReadAccess({ platformRole: user.role, isAdmin: user.isAdmin, roles, grantedModulePaths: modules.filter(m => grantedIds.has(String(m.id))).map(m => m.base_path) });
  // Assignment Center access is the explicit authorization to assign within the actor's
  // home department. It never implies global scope; only a GLOBAL_ASSIGNOR grant does that.
  if (readAccess.workspaces.includes("assignor") && !roles.includes("GLOBAL_ASSIGNOR") && !roles.includes("DEPARTMENT_ASSIGNOR")) roles.push("DEPARTMENT_ASSIGNOR");
  const actor: Employee = { id: userId, name: [user.user_fname, user.user_lname].filter(Boolean).join(" "), department_id: String(user.user_department ?? ""), department: departments[0]?.department_name ?? "No department", roles, read_workspaces: readAccess.workspaces, read_all_departments: readAccess.allDepartments };
   return { mode: "LIVE", writes_enabled: true, uploads_enabled: true, reference_uploads_enabled: false, workspace_access: readAccess.workspaces, actor, identities: [], employees: [actor], capabilities: { assign: roles.includes("GLOBAL_ASSIGNOR") || roles.includes("DEPARTMENT_ASSIGNOR"), global: roles.includes("GLOBAL_ASSIGNOR"), executive: workspaceAllowed(actor, "executive") }, blockers: ["Task reference attachments are not enabled. Deliverable uploads are available in My Tasks."] };
}

export async function liveCreateTask(raw: unknown, key: string, workspace: Workspace) {
 const bootstrap = await liveBootstrap();
 requireRule(workspace === "assignor", 403, "ASSIGNOR_WORKSPACE_REQUIRED", "Create tasks from the Assignor workspace.");
  requireRule(bootstrap.writes_enabled, 503, "WRITES_DISABLED", "Task creation is not currently available.");
  const database = new DirectusClient(process.env.NEXT_PUBLIC_API_BASE_URL ?? "", process.env.DIRECTUS_STATIC_TOKEN ?? "");
 const reader = new LiveReader((collection, fields, filter, limit, page) => database.read(collection, fields, filter, limit, page));
 const employees = await reader.directory(bootstrap.actor, "assignor");
 if (!employees.some(employee => employee.id === bootstrap.actor.id)) employees.push(bootstrap.actor);
  return new TaskWriter(database).save(bootstrap.actor, employees, raw, key);
}

function workDatabase() {
  return new DirectusClient(process.env.NEXT_PUBLIC_API_BASE_URL ?? "", process.env.DIRECTUS_STATIC_TOKEN ?? "");
}

export async function liveStageUpload(file: File, workspace: Workspace) {
 const bootstrap = await liveBootstrap();
  requireRule(workspace === "my-tasks" && bootstrap.uploads_enabled, 403, "UPLOADS_UNAVAILABLE", "Deliverable uploads are not currently available in this workspace.");
 requireRule(file.size > 0, 422, "FILE_REQUIRED", "Choose a nonempty file.");
 requireRule(file.size <= 5 * 1024 * 1024, 413, "FILE_TOO_LARGE", "Each attachment must be no larger than 5 MB.");
  const db = workDatabase();
 const safeName = file.name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 255) || "attachment";
 const mime = file.type.slice(0, 255) || "application/octet-stream";
 const bytes = new Uint8Array(await file.arrayBuffer());
 const digest = createHash("sha256").update(bytes).digest("hex");
 const uploaded = await db.upload(safeName, mime, bytes);
 requireRule(typeof uploaded.id === "string", 502, "UPLOAD_FAILED", "The file service did not return a file identifier.");
 try {
  const row = await db.create("pm_work_staged_upload", {
   owner_id: bootstrap.actor.id, directus_file_id: uploaded.id, state: "VERIFIED", original_filename: safeName,
   mime_type: mime, size_bytes: file.size, sha256: digest, verified_at: new Date().toISOString(),
   expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), created_at: new Date().toISOString(),
  });
  return { id: String(row.id), owner_id: bootstrap.actor.id, name: safeName, mime, size: file.size, sha256: digest, expires_at: String(row.expires_at), state: "VERIFIED" as const, bytes: "" };
 } catch (error) {
  console.error("[work-management] File uploaded but staged metadata failed", { fileId: uploaded.id });
  throw error;
 }
}

export async function liveSubmitOccurrence(occurrenceId: string, raw: unknown, key: string, workspace: Workspace) {
  const bootstrap = await liveBootstrap(); const db = workDatabase();
 requireRule(workspace === "my-tasks", 403, "ASSIGNEE_WORKSPACE_REQUIRED", "Submit deliverables from My Tasks.");
 requireRule(/^[A-Za-z0-9:_-]{8,128}$/.test(key), 422, "IDEMPOTENCY_REQUIRED", "A valid idempotency key is required.");
 const input = SubmissionInput.parse(raw);
 const reader = new LiveReader((collection, fields, filter, limit, page) => db.read(collection, fields, filter, limit, page));
 const detail = await reader.detail(bootstrap.actor, "my-tasks", occurrenceId);
 requireRule(detail.can_submit, 403, "SUBMISSION_NOT_ALLOWED", "This obligation is not available for submission by your account.");
 requireRule(input.expected_revision === detail.row_version, 409, "STALE_REVISION", "This obligation changed. Refresh the details before submitting.");
 const hash = createHash("sha256").update(JSON.stringify({ occurrenceId, ...input })).digest("hex");
  const operation = `submission:${occurrenceId}`;
  // Include the historical command key so existing idempotency records remain effective.
  const scope = { actor_key: { _eq: `wm:user:${bootstrap.actor.id}` }, operation: { _eq: operation }, idempotency_key: { _eq: key } };
 const previous = (await db.read("pm_work_idempotency", ["id", "state", "request_sha256", "response_body"], scope, 1))[0];
 if (previous) {
  requireRule(previous.request_sha256 === hash, 409, "IDEMPOTENCY_MISMATCH", "This submission key was already used with different details.");
  requireRule(previous.state === "COMPLETED", 409, "SAVE_IN_PROGRESS", "This submission is pending; refresh the task before retrying.");
  return typeof previous.response_body === "string" ? JSON.parse(previous.response_body) : previous.response_body;
 }
 const staged = await db.read("pm_work_staged_upload", ["id", "owner_id", "directus_file_id", "state", "original_filename", "mime_type", "size_bytes", "sha256", "expires_at"], { id: { _in: input.file_upload_ids } }, 10);
 requireRule(staged.length === input.file_upload_ids.length && staged.every(file => String(file.owner_id) === bootstrap.actor.id && file.state === "VERIFIED" && parseUtcTimestamp(String(file.expires_at)) > Date.now() && Number(file.size_bytes) > 0 && Number(file.size_bytes) <= 5 * 1024 * 1024), 422, "INVALID_UPLOAD", "An attachment is expired, invalid, oversized, or belongs to another account. Select it again.");
  const reservation = await db.create("pm_work_idempotency", { actor_key: `wm:user:${bootstrap.actor.id}`, operation, idempotency_key: key, request_sha256: hash, state: "IN_PROGRESS", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() });
 const created: { collection: string; ids: string[] }[] = [];
 const record = async (collection: string, body: Record<string, unknown>) => { const row = await db.create(collection, body); created.push({ collection, ids: [String(row.id)] }); return row; };
 try {
  const versions = await db.read("pm_work_submission", ["id", "version_number"], { occurrence_id: { _eq: occurrenceId } }, 250);
  const now = new Date().toISOString(); const version = versions.reduce((max, row) => Math.max(max, Number(row.version_number)), 0) + 1;
  const late = now > detail.due_at;
  const submission = await record("pm_work_submission", { occurrence_id: occurrenceId, version_number: version, submitted_by: bootstrap.actor.id, remark: input.remark, revision_reason: "", submitted_at: now, evaluated_due_at: detail.due_at, is_late: late, created_at: now });
  const links = [];
  for (const file of staged) {
   const link = await record("pm_work_submission_file", { submission_id: submission.id, staged_upload_id: file.id, directus_file_id: file.directus_file_id, original_filename: file.original_filename, mime_type: file.mime_type, size_bytes: file.size_bytes, sha256: file.sha256, uploaded_at: now });
   links.push(link);
  }
  const event = await record("pm_work_audit_event", { event_type: version === 1 ? "SUBMISSION_CREATED" : "SUBMISSION_REVISED", actor_id: bootstrap.actor.id, entity_type: "submission", entity_id: submission.id, task_id: detail.task_id, occurrence_id: occurrenceId, task_revision_number: detail.task.revision_number, old_values: null, new_values: { submission_id: submission.id, version, is_late: late, file_count: links.length }, reason: version === 1 ? "Deliverable submitted" : "Deliverable version resubmitted", request_id: key, created_at: now });
  await record("pm_work_outbox", { event_id: event.id, type: String(event.event_type), payload: { task_id: detail.task_id, occurrence_id: occurrenceId, recipient_ids: [...new Set([detail.task.created_by, detail.task.report_to_user_id])] }, dedupe_key: `work:${event.id}`, attempts: 0, next_attempt_at: now, created_at: now });
  for (const file of staged) await db.update("pm_work_staged_upload", String(file.id), { state: "CLAIMED", claimed_at: now });
  const occurrencePatch: Record<string, unknown> = { latest_submission_id: submission.id, status: "COMPLETED", row_version: detail.row_version + 1, updated_at: now };
  if (!detail.first_submission_id) { occurrencePatch.first_submission_id = submission.id; occurrencePatch.completed_at = now; }
  await db.update("pm_work_occurrence", occurrenceId, occurrencePatch);
  const result = { id: String(submission.id), occurrence_id: occurrenceId, version_number: version, file_count: links.length, is_late: late, persistence: "directus", atomic: false };
  await db.update("pm_work_idempotency", String(reservation.id), { state: "COMPLETED", completed_at: now, response_status: 201, response_body: result });
  return result;
 } catch (error) {
  let cleaned = true;
  for (const entry of created.reverse()) { try { await db.remove(entry.collection, entry.ids); } catch { cleaned = false; } }
  if (cleaned) { try { await db.remove("pm_work_idempotency", [String(reservation.id)]); } catch { cleaned = false; } }
   console.error("[work-management] Submission failed", { occurrenceId, requestId: key, cleanupCompletedForKnownRows: cleaned, error: error instanceof WorkError ? error.code : "NETWORK_OR_UNEXPECTED_ERROR" });
   throw new WorkError(503, "SUBMISSION_FAILED", `Submission failed. ${cleaned ? "Cleanup of known created rows completed." : "Cleanup was incomplete; refresh and inspect before retrying."} Request: ${key}`);
 }
}

export async function liveRead(path: string[], workspace: Workspace, period: ReadPeriod): Promise<unknown> {
 const { actor } = await liveBootstrap();
 const route = path.join("/");
 if (path[0] === "occurrences" && /^\d+$/.test(path[1] ?? "")) {
  const reader = new LiveReader((collection, fields, filter, limit, page) => readRows<Record<string, unknown>>(collection, fields, filter, limit, page));
  const detail = await reader.detail(actor, workspace, path[1]);
  if (path[2] === "submissions") return detail.submissions;
  if (path[2] === "audit-events") return detail.events;
  requireRule(path.length === 2, 404, "NOT_FOUND", "Endpoint not found.");
  return detail;
 }
 if (route === "directory") {
  const reader = new LiveReader((collection, fields, filter, limit, page) => readRows<Record<string, unknown>>(collection, fields, filter, limit, page));
  return reader.directory(actor, workspace);
 }
 if (route === "notifications") return readRows("pm_work_notification", ["id", "recipient_id", "event_id", "type", "payload", "read_at", "created_at"], { recipient_id: { _eq: actor.id } }, 100);
 const supported = ["occurrences", "occurrences/calendar", "occurrences/backlog", "reviews", "analytics/company", "analytics/employees", "analytics/departments", "analytics/trends"];
 requireRule(supported.includes(route), 503, "LIVE_READ_NOT_READY", "This live read endpoint is not implemented yet. Calendar and reporting reads are available; no write was attempted.");
 if (path[0] === "analytics") requireRule(workspace === "executive" && workspaceAllowed(actor, "executive"), 403, "FORBIDDEN", "Executive access is required.");
 const reader = new LiveReader((collection, fields, filter, limit, page) => readRows<Record<string, unknown>>(collection, fields, filter, limit, page));
 const reviewView = route === "reviews" && workspace !== "my-tasks";
 const engine = await reader.load(actor, workspace, period, reviewView);
 if (route === "occurrences" || route === "occurrences/calendar" || route === "reviews" || route === "occurrences/backlog") {
  const today = addDays(localDate(new Date(engine.now)), 1);
  const rows = route === "occurrences/backlog" ? engine.list("1900-01-01", today, period.employee).filter(o => !o.first_submission_id && o.status !== "CANCELLED" && o.due_at < engine.now)
   : engine.list(period.from, period.to, period.employee, reviewView).filter(o => route !== "reviews" || !!o.first_submission_id);
  // Final boundary check: My Tasks can only ever return the signed-in assignee's rows.
  const scoped = workspace === "my-tasks" ? rows.filter(o => o.assignee.id === actor.id) : rows;
  return { items: scoped.slice((period.page - 1) * period.limit, period.page * period.limit), total: scoped.length, summary: engine.summary(period.from, period.to, period.employee) };
 }
 if (route === "analytics/company") return engine.summary(period.from, period.to, period.employee);
 if (route === "analytics/trends") {
  const rows = [];
  for (let day = period.from; day <= period.to; day = addDays(day, 1)) { const s = engine.summary(day, day, period.employee); rows.push({ date: day, due: s.due, submitted: s.submitted, on_time: s.on_time }); }
  return rows;
 }
 const employees = engine.state.employees.map(employee => ({ ...employee, ...engine.summary(period.from, period.to, employee.id) }));
 if (route === "analytics/departments") return [...new Set(employees.map(e => e.department_id))].map(id => {
  const group = employees.filter(e => e.department_id === id);
  return { department_id: id, name: group[0].department, due: group.reduce((n, e) => n + e.due, 0), submitted: group.reduce((n, e) => n + e.submitted, 0), on_time: group.reduce((n, e) => n + e.on_time, 0), overdue: group.reduce((n, e) => n + e.overdue, 0) };
 });
 return { summary: engine.summary(period.from, period.to, period.employee), employees };
}

export async function liveDownload(fileId: string, workspace: Workspace): Promise<Response> {
 const { actor } = await liveBootstrap();
 const match = /^submission:(\d+)$/.exec(fileId);
 requireRule(match, 404, "NOT_FOUND", "File not found.");
 const file = (await readRows<Record<string, unknown>>("pm_work_submission_file", ["id", "submission_id", "directus_file_id", "original_filename"], { id: { _eq: match[1] } }, 1))[0];
 requireRule(file, 404, "NOT_FOUND", "File not found.");
 const submission = (await readRows<{ occurrence_id: string | number }>("pm_work_submission", ["occurrence_id"], { id: { _eq: file.submission_id } }, 1))[0];
 requireRule(submission, 404, "NOT_FOUND", "File not found.");
 const reader = new LiveReader((collection, fields, filter, limit, page) => readRows<Record<string, unknown>>(collection, fields, filter, limit, page));
 const detail = await reader.detail(actor, workspace, String(submission.occurrence_id));
 requireRule(detail.files.some(candidate => candidate.id === fileId), 404, "NOT_FOUND", "File not found.");
 const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");
 const response = await fetch(`${base}/assets/${encodeURIComponent(String(file.directus_file_id))}`, { headers: { Authorization: `Bearer ${process.env.DIRECTUS_STATIC_TOKEN}` }, cache: "no-store", signal: AbortSignal.timeout(30000) });
 requireRule(response.ok && response.body, 502, "FILE_STORAGE_UNAVAILABLE", "Unable to read the authorized file.");
 return new Response(response.body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(String(file.original_filename))}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
}

/** Do not replace this with non-atomic REST writes. Deployment is an explicit blocker. */
export async function liveReleaseBlocker(): Promise<never> {
 await verifiedActor();
  throw new WorkError(503, "LIVE_INTEGRATION_BLOCKED", "Work Management changes are not available until the transactional command service, private upload scanning, and explicit role grants are configured. No business write was attempted.");
}

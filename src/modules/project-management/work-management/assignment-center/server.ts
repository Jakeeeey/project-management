import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { COOKIE_NAME, decodeJwtPayload } from "@/lib/auth-utils";
import { canEdit, requireRule, WorkError, workspaceAllowed } from "./policies";
import type { Bootstrap, Employee, Role, Schedule, Task, Workspace } from "./types";
import { isActiveEmployeeFlag } from "./employee-policy";
import { LiveReader, type ReadPeriod } from "./live-read";
import { addDays, localDate, parseUtcTimestamp, wallToUtc } from "./recurrence";
import { resolveWorkspaceReadAccess } from "./workspace-access";
import { DirectusClient } from "./directus-client";
import { TaskWriter } from "./task-writer";
import { Amendment, DeadlineInput, ReasonInput, SubmissionInput } from "./schemas";
import { emptyState, WorkEngine } from "./engine";

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
   return { mode: "LIVE", writes_enabled: true, uploads_enabled: false, reference_uploads_enabled: false, workspace_access: readAccess.workspaces, actor, identities: [], employees: [actor], capabilities: { assign: roles.includes("GLOBAL_ASSIGNOR") || roles.includes("DEPARTMENT_ASSIGNOR"), global: roles.includes("GLOBAL_ASSIGNOR"), executive: workspaceAllowed(actor, "executive") }, blockers: ["Task reference attachments are not enabled in this workspace."] };
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

/** Audited multi-occurrence review actions. Every selected item is authorized before writes begin. */
export async function liveReviewBulk(raw: unknown, key: string, workspace: Workspace) {
 const bootstrap = await liveBootstrap();
 requireRule(workspace === "assignor", 403, "ASSIGNOR_WORKSPACE_REQUIRED", "Review submissions from Assignment Center.");
 requireRule(/^[A-Za-z0-9:_-]{8,128}$/.test(key), 422, "IDEMPOTENCY_REQUIRED", "Provide a valid request key.");
 const input = raw as { occurrence_ids?: unknown; mark_done?: unknown; comment?: unknown; reason?: unknown };
 requireRule(Array.isArray(input.occurrence_ids) && input.occurrence_ids.length > 0 && input.occurrence_ids.length <= 100 && input.occurrence_ids.every(id => typeof id === "string" && /^\d+$/.test(id)), 422, "INVALID_SELECTION", "Select between 1 and 100 valid obligations.");
 requireRule(input.mark_done === true || typeof input.comment === "string" && input.comment.trim().length > 0, 422, "ACTION_REQUIRED", "Choose a status update or enter a comment.");
 requireRule(typeof input.reason === "string" && input.reason.trim().length > 0 && input.reason.length <= 2000, 422, "REASON_REQUIRED", "A reason is required for every review update.");
 if (input.comment !== undefined) requireRule(typeof input.comment === "string" && input.comment.trim().length <= 10000, 422, "INVALID_COMMENT", "Comments must be no longer than 10,000 characters.");
 const ids = [...new Set(input.occurrence_ids as string[])];
 requireRule(ids.length === input.occurrence_ids.length, 422, "DUPLICATE_SELECTION", "The selected obligations contain duplicates.");
 const db = workDatabase();
 const reader = new LiveReader((collection, fields, filter, limit, page) => db.read(collection, fields, filter, limit, page));
 const details = await Promise.all(ids.map(id => reader.detail(bootstrap.actor, workspace, id)));
 requireRule(details.every(detail => detail.can_edit && !!detail.first_submission_id), 403, "REVIEW_NOT_ALLOWED", "You can review only submitted work within your assignment scope.");
 const now = new Date().toISOString();
 const results = [];
 for (const detail of details) {
  const changes: string[] = [];
  if (input.mark_done === true) {
   await db.update("pm_work_occurrence", detail.id, { status: "COMPLETED", completed_at: detail.completed_at ?? now, row_version: detail.row_version + 1, updated_at: now });
   changes.push("done");
  }
  let commentId: string | undefined;
  if (typeof input.comment === "string" && input.comment.trim()) {
   const comment = await db.create("pm_work_comment", { occurrence_id: detail.id, submission_id: detail.latest_submission_id, author_id: bootstrap.actor.id, comment_text: input.comment.trim(), created_at: now });
   commentId = String(comment.id); changes.push("comment");
  }
  const event = await db.create("pm_work_audit_event", { event_type: input.mark_done === true ? "OCCURRENCE_REVIEWED" : "SUBMISSION_COMMENTED", actor_id: bootstrap.actor.id, entity_type: "occurrence", entity_id: detail.id, task_id: detail.task_id, occurrence_id: detail.id, task_revision_number: detail.task.revision_number, old_values: null, new_values: { status: input.mark_done === true ? "COMPLETED" : undefined, comment_id: commentId, comment: typeof input.comment === "string" ? input.comment.trim() : undefined }, reason: input.reason.trim(), request_id: key, created_at: now });
  await db.create("pm_work_notification", { recipient_id: detail.assignee.id, event_id: event.id, type: String(event.event_type), payload: { task_id: detail.task_id, occurrence_id: detail.id, title: detail.task.title, reason: input.reason.trim(), changes, comment: typeof input.comment === "string" ? input.comment.trim() : undefined }, dedupe_key: `work:${event.id}:${detail.assignee.id}`, created_at: now });
  results.push({ occurrence_id: detail.id, changes });
 }
 return { updated: results.length, items: results };
}

export async function liveAddComment(occurrenceId: string, raw: unknown, key: string, workspace: Workspace) {
 const bootstrap = await liveBootstrap();
 requireRule(workspace === "assignor" && /^\d+$/.test(occurrenceId), 403, "ASSIGNOR_WORKSPACE_REQUIRED", "Comment from Assignment Center.");
 requireRule(/^[A-Za-z0-9:_-]{8,128}$/.test(key), 422, "IDEMPOTENCY_REQUIRED", "Provide a valid request key.");
 const input = raw as { text?: unknown; submission_id?: unknown };
 requireRule(typeof input.text === "string" && !!input.text.trim() && input.text.length <= 10000, 422, "INVALID_COMMENT", "Enter a comment of up to 10,000 characters.");
 const db = workDatabase();
 const reader = new LiveReader((collection, fields, filter, limit, page) => db.read(collection, fields, filter, limit, page));
 const detail = await reader.detail(bootstrap.actor, workspace, occurrenceId);
 requireRule(detail.can_comment, 403, "COMMENT_NOT_ALLOWED", "You cannot comment on this task.");
 if (input.submission_id !== undefined) requireRule(detail.submissions.some(submission => submission.id === input.submission_id), 404, "SUBMISSION_NOT_FOUND", "Submission not found.");
 const now = new Date().toISOString();
 const comment = await db.create("pm_work_comment", { occurrence_id: occurrenceId, submission_id: input.submission_id ?? detail.latest_submission_id, author_id: bootstrap.actor.id, comment_text: input.text.trim(), created_at: now });
 const event = await db.create("pm_work_audit_event", { event_type: "SUBMISSION_COMMENTED", actor_id: bootstrap.actor.id, entity_type: "occurrence", entity_id: occurrenceId, task_id: detail.task_id, occurrence_id: occurrenceId, task_revision_number: detail.task.revision_number, old_values: null, new_values: { comment_id: comment.id, comment: input.text.trim() }, reason: "Comment added", request_id: key, created_at: now });
 await db.create("pm_work_notification", { recipient_id: detail.assignee.id, event_id: event.id, type: "SUBMISSION_COMMENTED", payload: { task_id: detail.task_id, occurrence_id: occurrenceId, title: detail.task.title, comment: input.text.trim() }, dedupe_key: `work:${event.id}:${detail.assignee.id}`, created_at: now });
 return { id: String(comment.id), occurrence_id: occurrenceId };
}

export async function liveCancelOccurrence(occurrenceId: string, raw: unknown, key: string, workspace: Workspace) {
 const bootstrap = await liveBootstrap();
 requireRule(workspace === "assignor" && /^\d+$/.test(occurrenceId), 403, "ASSIGNOR_WORKSPACE_REQUIRED", "Cancel work from Assignment Center.");
 requireRule(/^[A-Za-z0-9:_-]{8,128}$/.test(key), 422, "IDEMPOTENCY_REQUIRED", "Provide a valid request key.");
 const input = ReasonInput.parse(raw); const db = workDatabase();
 const reader = new LiveReader((collection, fields, filter, limit, page) => db.read(collection, fields, filter, limit, page));
 const detail = await reader.detail(bootstrap.actor, workspace, occurrenceId);
 requireRule(detail.can_edit, 403, "FORBIDDEN", "You cannot manage this task.");
 requireRule(detail.row_version === input.expected_revision, 409, "STALE_REVISION", "This obligation changed. Refresh before trying again.");
 requireRule(!detail.first_submission_id && detail.status !== "CANCELLED", 422, "INVALID_TRANSITION", "Only unsubmitted occurrences can be cancelled.");
 const now = new Date().toISOString();
 await db.update("pm_work_occurrence", occurrenceId, { status: "CANCELLED", cancelled_at: now, cancellation_reason: input.reason, row_version: detail.row_version + 1, updated_at: now });
 const event = await db.create("pm_work_audit_event", { event_type: "OCCURRENCE_CANCELLED", actor_id: bootstrap.actor.id, entity_type: "occurrence", entity_id: occurrenceId, task_id: detail.task_id, occurrence_id: occurrenceId, task_revision_number: detail.task.revision_number, old_values: { status: detail.status }, new_values: { status: "CANCELLED" }, reason: input.reason, request_id: key, created_at: now });
 await db.create("pm_work_notification", { recipient_id: detail.assignee.id, event_id: event.id, type: "OCCURRENCE_CANCELLED", payload: { task_id: detail.task_id, occurrence_id: occurrenceId, title: detail.task_revision.title, reason: input.reason, old_values: { status: detail.status }, new_values: { status: "CANCELLED" } }, dedupe_key: `work:${event.id}:${detail.assignee.id}`, created_at: now });
 return { occurrence_id: occurrenceId, assignee_id: detail.assignee.id, status: "CANCELLED" };
}

export async function liveChangeDeadline(occurrenceId: string, raw: unknown, key: string, workspace: Workspace) {
 const bootstrap = await liveBootstrap();
 requireRule(workspace === "assignor" && /^\d+$/.test(occurrenceId), 403, "ASSIGNOR_WORKSPACE_REQUIRED", "Change deadlines from Assignment Center.");
 requireRule(/^[A-Za-z0-9:_-]{8,128}$/.test(key), 422, "IDEMPOTENCY_REQUIRED", "Provide a valid request key.");
 const input = DeadlineInput.parse(raw); const db = workDatabase();
 const reader = new LiveReader((collection, fields, filter, limit, page) => db.read(collection, fields, filter, limit, page));
 const detail = await reader.detail(bootstrap.actor, workspace, occurrenceId);
 requireRule(detail.can_edit, 403, "FORBIDDEN", "You cannot manage this task.");
 requireRule(detail.row_version === input.expected_revision, 409, "STALE_REVISION", "This obligation changed. Refresh before trying again.");
 requireRule(!detail.first_submission_id && detail.status !== "CANCELLED", 422, "IMMUTABLE_HISTORY", "Submitted or cancelled deadlines cannot be changed.");
 const dueAt = new Date(input.due_at).toISOString();
 requireRule(dueAt >= detail.available_at, 422, "INVALID_DEADLINE", "Deadline cannot be earlier than the availability time.");
 const now = new Date().toISOString();
 await db.update("pm_work_occurrence", occurrenceId, { due_at: dueAt, row_version: detail.row_version + 1, updated_at: now });
 const event = await db.create("pm_work_audit_event", { event_type: "TASK_DEADLINE_CHANGED", actor_id: bootstrap.actor.id, entity_type: "occurrence", entity_id: occurrenceId, task_id: detail.task_id, occurrence_id: occurrenceId, task_revision_number: detail.task.revision_number, old_values: { due_at: detail.due_at }, new_values: { due_at: dueAt }, reason: input.reason, request_id: key, created_at: now });
 await db.create("pm_work_notification", { recipient_id: detail.assignee.id, event_id: event.id, type: "TASK_DEADLINE_CHANGED", payload: { task_id: detail.task_id, occurrence_id: occurrenceId, title: detail.task_revision.title, old_values: { due_at: detail.due_at }, new_values: { due_at: dueAt }, reason: input.reason }, dedupe_key: `work:${event.id}:${detail.assignee.id}`, created_at: now });
 return { occurrence_id: occurrenceId, due_at: dueAt, row_version: detail.row_version + 1 };
}

export async function liveOccurrenceCancelTargets(occurrenceId: string, workspace: Workspace) {
 const bootstrap = await liveBootstrap(); const db = workDatabase();
 const reader = new LiveReader((collection, fields, filter, limit, page) => db.read(collection, fields, filter, limit, page));
 const detail = await reader.detail(bootstrap.actor, workspace, occurrenceId);
 requireRule(detail.can_edit, 403, "FORBIDDEN", "You cannot manage this task.");
 const current = (await db.read("pm_work_occurrence", ["task_id", "assignment_id", "occurrence_key"], { id: { _eq: occurrenceId } }, 1))[0];
 requireRule(current, 404, "NOT_FOUND", "Occurrence not found.");
 const siblings = await db.read("pm_work_occurrence", ["id", "assignment_id", "row_version", "status", "first_submission_id"], { task_id: { _eq: current.task_id }, occurrence_key: { _eq: current.occurrence_key } }, 500);
 const assignments = await db.read("pm_work_assignment", ["id", "assignee_user_id", "status"], { id: { _in: siblings.map(row => row.assignment_id) } }, 500);
 const directory = await reader.directory(bootstrap.actor, workspace);
 return siblings.map(row => {
  const assignment = assignments.find(value => String(value.id) === String(row.assignment_id));
  const assigneeId = String(assignment?.assignee_user_id ?? "");
  return { id: String(row.id), assignee_id: assigneeId, assignee_name: directory.find(person => person.id === assigneeId)?.name ?? `Employee ${assigneeId}`, row_version: Number(row.row_version), status: String(row.status), submitted: !!row.first_submission_id, selectable: !row.first_submission_id && row.status !== "CANCELLED" };
 });
}

export async function liveAmendTask(taskId: string, raw: unknown, key: string, workspace: Workspace) {
 const bootstrap = await liveBootstrap();
 requireRule(workspace === "assignor" && /^\d+$/.test(taskId), 403, "ASSIGNOR_WORKSPACE_REQUIRED", "Edit tasks from Assignment Center.");
 requireRule(/^[A-Za-z0-9:_-]{8,128}$/.test(key), 422, "IDEMPOTENCY_REQUIRED", "Provide a valid request key.");
 const input = Amendment.parse(raw); const db = workDatabase();
 const [taskRow, recurrenceRows, assignmentRows, employeeDirectory] = await Promise.all([
  db.read("pm_work_task", ["id", "title", "description", "scope_type", "department_id", "created_by", "report_to_user_id", "priority", "availability_start_at", "revision_number", "lifecycle_status", "created_at"], { id: { _eq: taskId } }, 1).then(rows => rows[0]),
  db.read("pm_work_recurrence", ["id", "schedule_version", "frequency", "interval_value", "interval_unit", "days_of_week", "day_of_month", "month_end_policy", "due_local_time", "timezone", "start_date", "end_date", "until_count"], { task_id: { _eq: taskId } }, 100),
  db.read("pm_work_assignment", ["id", "task_id", "assignee_user_id", "department_id_at_assignment", "status"], { task_id: { _eq: taskId } }, 500),
  new LiveReader((collection, fields, filter, limit, page) => db.read(collection, fields, filter, limit, page)).directory(bootstrap.actor, "assignor"),
 ]);
 requireRule(taskRow, 404, "NOT_FOUND", "Task not found.");
 const existingScheduleRow = recurrenceRows.sort((a, b) => Number(b.schedule_version) - Number(a.schedule_version))[0];
 requireRule(existingScheduleRow, 502, "MISSING_SCHEDULE", "Task schedule is unavailable.");
 const weekdays = typeof existingScheduleRow.days_of_week === "string" ? JSON.parse(existingScheduleRow.days_of_week) : existingScheduleRow.days_of_week;
 const oldSchedule: Schedule = { frequency: existingScheduleRow.frequency as Schedule["frequency"], interval_value: Number(existingScheduleRow.interval_value), interval_unit: existingScheduleRow.interval_unit as Schedule["interval_unit"] ?? undefined, days_of_week: Array.isArray(weekdays) ? weekdays : [], day_of_month: existingScheduleRow.day_of_month == null ? undefined : Number(existingScheduleRow.day_of_month), month_end_policy: existingScheduleRow.month_end_policy as Schedule["month_end_policy"], due_local_time: String(existingScheduleRow.due_local_time), timezone: String(existingScheduleRow.timezone), start_date: String(existingScheduleRow.start_date).slice(0, 10), end_date: existingScheduleRow.end_date ? String(existingScheduleRow.end_date).slice(0, 10) : undefined, until_count: existingScheduleRow.until_count ? Number(existingScheduleRow.until_count) : undefined };
 const task: Task = { id: taskId, title: String(taskRow.title), description: String(taskRow.description), scope_type: taskRow.scope_type as Task["scope_type"], department_id: taskRow.department_id == null ? null : String(taskRow.department_id), created_by: String(taskRow.created_by), report_to_user_id: String(taskRow.report_to_user_id), priority: taskRow.priority as Task["priority"], availability_start_at: parseUtcTimestamp(String(taskRow.availability_start_at)) ? new Date(parseUtcTimestamp(String(taskRow.availability_start_at))).toISOString() : String(taskRow.availability_start_at), schedule: oldSchedule, schedule_version: Number(existingScheduleRow.schedule_version), schedule_effective_at: String(taskRow.availability_start_at), revision_number: Number(taskRow.revision_number), lifecycle_status: taskRow.lifecycle_status as Task["lifecycle_status"], created_at: String(taskRow.created_at), reference_file_ids: [] };
 requireRule(canEdit(bootstrap.actor, task), 403, "FORBIDDEN", "You cannot edit this task.");
 requireRule(input.expected_revision === task.revision_number, 409, "STALE_REVISION", "This task changed. Refresh before editing.");
 requireRule(input.scope_type === task.scope_type && String(input.department_id ?? "") === String(task.department_id ?? ""), 422, "IMMUTABLE_SCOPE", "Task ownership scope cannot be changed by editing.");
 const state = emptyState(); state.employees = employeeDirectory;
 if (!state.employees.some(person => person.id === bootstrap.actor.id)) state.employees.push(bootstrap.actor);
 state.tasks = [task];
 state.assignments = assignmentRows.map(row => ({ id: String(row.id), task_id: taskId, assignee_user_id: String(row.assignee_user_id), department_id_at_assignment: String(row.department_id_at_assignment), status: row.status as "ACTIVE" | "ENDED" }));
 const engine = new WorkEngine(state, bootstrap.actor, "assignor");
 const updated = engine.amend(taskId, input, key);
 const scheduleChanged = JSON.stringify(oldSchedule) !== JSON.stringify(updated.schedule);
 const now = new Date().toISOString();
 const revision = await db.create("pm_work_task_revision", { task_id: taskId, revision_number: updated.revision_number, changed_by: bootstrap.actor.id, change_reason: input.reason, snapshot: updated, changed_at: now });
 let recurrenceId = String(existingScheduleRow.id);
 if (scheduleChanged) {
  const schedule = updated.schedule;
  const recurrence = await db.create("pm_work_recurrence", { task_id: taskId, schedule_version: updated.schedule_version, frequency: schedule.frequency, interval_value: schedule.interval_value, interval_unit: schedule.frequency === "CUSTOM" ? schedule.interval_unit : null, days_of_week: schedule.days_of_week, day_of_month: schedule.day_of_month ?? null, month_end_policy: schedule.month_end_policy, due_local_time: schedule.due_local_time, timezone: schedule.timezone, start_date: schedule.start_date, end_date: schedule.end_date ?? null, until_count: schedule.until_count ?? null, effective_from: localDate(new Date(now), schedule.timezone), created_at: now });
  recurrenceId = String(recurrence.id);
 }
 await db.update("pm_work_task", taskId, { title: updated.title, description: updated.description, report_to_user_id: updated.report_to_user_id, priority: updated.priority, availability_start_at: updated.availability_start_at, schedule_type: updated.schedule.frequency, revision_number: updated.revision_number, updated_at: now });
 const activeByUser = new Map(assignmentRows.filter(row => row.status === "ACTIVE").map(row => [String(row.assignee_user_id), row]));
 const dbAssignmentByUser = new Map<string, string>();
 for (const assignment of engine.state.assignments) {
  const existing = activeByUser.get(assignment.assignee_user_id);
  if (existing && assignment.status === "ACTIVE") dbAssignmentByUser.set(assignment.assignee_user_id, String(existing.id));
  else if (!existing && assignment.status === "ACTIVE") {
   const created = await db.create("pm_work_assignment", { task_id: taskId, assignee_user_id: assignment.assignee_user_id, department_id_at_assignment: assignment.department_id_at_assignment, assigned_by: bootstrap.actor.id, assigned_at: now, status: "ACTIVE" });
   dbAssignmentByUser.set(assignment.assignee_user_id, String(created.id));
  }
  if (existing && assignment.status === "ENDED") await db.update("pm_work_assignment", String(existing.id), { status: "ENDED" });
 }
 const openRows = await db.read("pm_work_occurrence", ["id", "assignment_id", "recurrence_id", "due_at", "first_submission_id", "status", "row_version"], { task_id: { _eq: taskId }, first_submission_id: { _null: true }, status: { _neq: "CANCELLED" } }, 5000);
 const activeDbIds = new Set([...dbAssignmentByUser.values()]);
 for (const occurrence of openRows) {
  const removed = !activeDbIds.has(String(occurrence.assignment_id));
  const future = String(occurrence.due_at) > now;
  if (removed || future && (scheduleChanged || String(occurrence.recurrence_id) !== recurrenceId)) {
   await db.update("pm_work_occurrence", String(occurrence.id), { status: "CANCELLED", cancelled_at: now, cancellation_reason: input.reason, row_version: Number(occurrence.row_version) + 1, updated_at: now });
  } else if (future && !removed) {
   // The occurrence snapshot powers all three workspace UIs; attach the new
   // revision when its recurrence remains valid so changed task details appear.
   await db.update("pm_work_occurrence", String(occurrence.id), { task_revision_id: revision.id, row_version: Number(occurrence.row_version) + 1, updated_at: now });
  }
 }
 for (const occurrence of engine.state.occurrences) {
  const assignment = engine.state.assignments.find(row => row.id === occurrence.assignment_id)!;
  const assignmentId = dbAssignmentByUser.get(assignment.assignee_user_id);
  if (!assignmentId) continue;
  const duplicate = await db.read("pm_work_occurrence", ["id"], { assignment_id: { _eq: assignmentId }, occurrence_key: { _eq: occurrence.occurrence_key } }, 1);
  if (duplicate.length) continue;
  await db.create("pm_work_occurrence", { task_id: taskId, assignment_id: assignmentId, recurrence_id: recurrenceId, task_revision_id: revision.id, occurrence_key: occurrence.occurrence_key, scheduled_local_date: occurrence.scheduled_local_date, available_at: occurrence.available_at, original_due_at: occurrence.original_due_at, due_at: occurrence.due_at, row_version: 1, status: occurrence.status, created_at: now, updated_at: now });
 }
 const event = await db.create("pm_work_audit_event", { event_type: scheduleChanged ? "TASK_SCHEDULE_CHANGED" : "TASK_DETAILS_UPDATED", actor_id: bootstrap.actor.id, entity_type: "task", entity_id: taskId, task_id: taskId, occurrence_id: null, task_revision_number: updated.revision_number, old_values: { title: task.title, priority: task.priority, schedule: oldSchedule }, new_values: { title: updated.title, priority: updated.priority, schedule: updated.schedule }, reason: input.reason, request_id: key, created_at: now });
 const recipients = new Set([...activeByUser.keys(), ...input.assignee_user_ids]);
 for (const recipientId of recipients) await db.create("pm_work_notification", { recipient_id: recipientId, event_id: event.id, type: String(event.event_type), payload: { task_id: taskId, title: updated.title, old_values: { title: task.title, priority: task.priority, schedule: oldSchedule }, new_values: { title: updated.title, priority: updated.priority, schedule: updated.schedule }, reason: input.reason }, dedupe_key: `work:${event.id}:${recipientId}`, created_at: now });
 return { id: taskId, revision_number: updated.revision_number, assignment_count: input.assignee_user_ids.length, occurrence_count: engine.state.occurrences.length };
}

export async function liveTaskLifecycle(taskId: string, action: string, raw: unknown, key: string, workspace: Workspace) {
 const bootstrap = await liveBootstrap();
 requireRule(workspace === "assignor", 403, "ASSIGNOR_WORKSPACE_REQUIRED", "Manage tasks from Assignment Center.");
 requireRule(/^\d+$/.test(taskId) && /^[A-Za-z0-9:_-]{8,128}$/.test(key), 422, "INVALID_REQUEST", "A valid task and request key are required.");
 const body = raw as { reason?: unknown; expected_revision?: unknown };
 requireRule(typeof body.reason === "string" && !!body.reason.trim() && body.reason.length <= 2000, 422, "REASON_REQUIRED", "A reason is required for this task change.");
 requireRule(Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) > 0, 422, "REVISION_REQUIRED", "Refresh this task before making a change.");
 requireRule(["pause", "resume", "cancel", "archive"].includes(action), 404, "NOT_FOUND", "Task action not found.");
 const db = workDatabase();
 const taskRow = (await db.read("pm_work_task", ["id", "title", "scope_type", "department_id", "lifecycle_status", "revision_number"], { id: { _eq: taskId } }, 1))[0];
 requireRule(taskRow, 404, "NOT_FOUND", "Task not found.");
 const task: Task = { id: taskId, title: String(taskRow.title), description: "", scope_type: taskRow.scope_type as Task["scope_type"], department_id: taskRow.department_id == null ? null : String(taskRow.department_id), created_by: bootstrap.actor.id, report_to_user_id: bootstrap.actor.id, priority: "NORMAL", availability_start_at: new Date(0).toISOString(), schedule: { frequency: "ONCE", interval_value: 1, days_of_week: [], month_end_policy: "CLAMP_TO_LAST_DAY", due_local_time: "00:00", timezone: "Asia/Manila", start_date: "1970-01-01" }, schedule_version: 1, schedule_effective_at: new Date(0).toISOString(), revision_number: Number(taskRow.revision_number), lifecycle_status: taskRow.lifecycle_status as Task["lifecycle_status"], created_at: new Date(0).toISOString(), reference_file_ids: [] };
 requireRule(canEdit(bootstrap.actor, task), 403, "FORBIDDEN", "You cannot manage this task.");
 requireRule(Number(body.expected_revision) === task.revision_number, 409, "STALE_REVISION", "This task changed. Refresh before trying again.");
 const nextStatus = action === "pause" ? "PAUSED" : action === "resume" ? "ACTIVE" : "CANCELLED";
 requireRule(action === "pause" && task.lifecycle_status === "ACTIVE" || action === "resume" && task.lifecycle_status === "PAUSED" || (action === "cancel" || action === "archive") && task.lifecycle_status !== "CANCELLED", 422, "INVALID_TRANSITION", "This task cannot make that status change.");
 const now = new Date().toISOString();
 const assignments = await db.read("pm_work_assignment", ["id", "assignee_user_id"], { task_id: { _eq: taskId }, status: { _eq: "ACTIVE" } }, 500);
 await db.update("pm_work_task", taskId, { lifecycle_status: nextStatus, revision_number: task.revision_number + 1, updated_at: now });
 if (nextStatus === "CANCELLED") {
  const open = await db.read("pm_work_occurrence", ["id", "row_version"], { task_id: { _eq: taskId }, first_submission_id: { _null: true }, status: { _neq: "CANCELLED" } }, 5000);
  for (const occurrence of open) await db.update("pm_work_occurrence", String(occurrence.id), { status: "CANCELLED", cancelled_at: now, cancellation_reason: body.reason.trim(), row_version: Number(occurrence.row_version) + 1, updated_at: now });
 }
 const event = await db.create("pm_work_audit_event", { event_type: action === "pause" ? "TASK_PAUSED" : action === "resume" ? "TASK_RESUMED" : "TASK_ARCHIVED", actor_id: bootstrap.actor.id, entity_type: "task", entity_id: taskId, task_id: taskId, occurrence_id: null, task_revision_number: task.revision_number + 1, old_values: { lifecycle_status: task.lifecycle_status }, new_values: { lifecycle_status: nextStatus, reason: body.reason.trim() }, reason: body.reason.trim(), request_id: key, created_at: now });
 for (const userId of [...new Set(assignments.map(row => String(row.assignee_user_id)))]) {
  await db.create("pm_work_notification", { recipient_id: userId, event_id: event.id, type: String(event.event_type), payload: { task_id: taskId, title: task.title, old_status: task.lifecycle_status, status: nextStatus, reason: body.reason.trim() }, dedupe_key: `work:${event.id}:${userId}`, created_at: now });
 }
 return { task_id: taskId, lifecycle_status: nextStatus, revision_number: task.revision_number + 1, notified: assignments.length };
}

export async function liveRead(path: string[], workspace: Workspace, period: ReadPeriod): Promise<unknown> {
 const { actor } = await liveBootstrap();
 const route = path.join("/");
  if (path[0] === "occurrences" && /^\d+$/.test(path[1] ?? "")) {
   if (path[2] === "cancel-targets") return liveOccurrenceCancelTargets(path[1], workspace);
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
 if (path[0] === "tasks" && /^\d+$/.test(path[1] ?? "") && path[2] === "assignments") {
  const taskRow = (await readRows<Record<string, unknown>>("pm_work_task", ["id", "scope_type", "department_id"], { id: { _eq: path[1] } }, 1))[0];
  requireRule(taskRow, 404, "NOT_FOUND", "Task not found.");
  requireRule(canEdit(actor, { scope_type: taskRow.scope_type, department_id: taskRow.department_id === null ? null : String(taskRow.department_id) } as Task), 403, "FORBIDDEN", "You cannot edit this task.");
  return readRows("pm_work_assignment", ["id", "task_id", "assignee_user_id", "department_id_at_assignment", "status"], { task_id: { _eq: path[1] } }, 500);
 }
 if (route === "notifications") return readRows("pm_work_notification", ["id", "recipient_id", "event_id", "type", "payload", "read_at", "created_at"], { recipient_id: { _eq: actor.id } }, 100);
 const supported = ["occurrences", "occurrences/calendar", "occurrences/backlog", "reviews", "analytics/company", "analytics/employees", "analytics/departments", "analytics/trends"];
 requireRule(supported.includes(route), 503, "LIVE_READ_NOT_READY", "This live read endpoint is not implemented yet. Calendar and reporting reads are available; no write was attempted.");
 if (path[0] === "analytics") requireRule(workspace === "executive" && workspaceAllowed(actor, "executive"), 403, "FORBIDDEN", "Executive access is required.");
 const reader = new LiveReader((collection, fields, filter, limit, page) => readRows<Record<string, unknown>>(collection, fields, filter, limit, page));
 const engine = await reader.load(actor, workspace, period, route === "reviews");
 if (route === "occurrences" || route === "occurrences/calendar" || route === "reviews" || route === "occurrences/backlog") {
  const rows = route === "occurrences/backlog" ? engine.list("1900-01-01", period.from, period.employee).filter(o => !o.first_submission_id && o.status !== "CANCELLED" && o.due_at < engine.now && o.due_at < wallToUtc(period.from, "00:00", "Asia/Manila"))
   : engine.list(period.from, period.to, period.employee, route === "reviews").filter(o => route !== "reviews" || !!o.first_submission_id);
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

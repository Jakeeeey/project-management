import type { Employee, Task, Workspace, Assignment } from "./types";

export class WorkError extends Error {
 constructor(public status: number, public code: string, message: string) { super(message); }
}
export function requireRule(ok: unknown, status: number, code: string, message: string): asserts ok {
 if (!ok) throw new WorkError(status, code, message);
}
export const globalAssignor = (a: Employee) => a.roles.includes("GLOBAL_ASSIGNOR");
export const canAssign = (a: Employee) => globalAssignor(a) || a.roles.includes("DEPARTMENT_ASSIGNOR");
export function workspaceAllowed(a: Employee, w: Workspace) {
  return w === "my-tasks" || a.read_workspaces?.includes(w) === true || (w === "executive" ? a.roles.includes("EXECUTIVE_VIEWER") : w === "departmental" ? a.roles.includes("DEPARTMENT_ASSIGNOR") && !!a.department_id : canAssign(a));
}
export function canEdit(a: Employee, t: Task) {
 return t.scope_type === "GLOBAL" ? globalAssignor(a) : globalAssignor(a) || (a.roles.includes("DEPARTMENT_ASSIGNOR") && a.department_id === t.department_id);
}
export function canRead(a: Employee, t: Task, assignment: Assignment, w: Workspace) {
  if (w === "executive" || w === "departmental") return workspaceAllowed(a, w);
 if (w === "my-tasks") return assignment.assignee_user_id === a.id;
 const readOnlyScope = a.read_workspaces?.includes("assignor") === true && (a.read_all_departments === true || !!a.department_id && assignment.department_id_at_assignment === a.department_id);
 return readOnlyScope || canEdit(a, t) || t.created_by === a.id || t.report_to_user_id === a.id || (a.roles.includes("DEPARTMENT_ASSIGNOR") && assignment.department_id_at_assignment === a.department_id);
}
export function assertMutableWorkspace(w: Workspace) {
  requireRule(w !== "executive" && w !== "departmental", 403, "READ_ONLY", "Overview workspaces are read-only.");
}

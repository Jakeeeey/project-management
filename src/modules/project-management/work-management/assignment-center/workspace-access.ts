import type { Role, Workspace } from "./types";

const ROOT = "/project-management/work-management";

/** Browser paths follow the manually registered sub-module names. API IDs stay stable. */
export function workspacePath(workspace: Workspace): string {
 return `${ROOT}/${workspace === "my-tasks" ? "assignee" : workspace === "departmental" ? "departmental-overview" : workspace}`;
}

export function normalizeWorkspace(value: string): Workspace | null {
 if (value === "assignee" || value === "my-tasks") return "my-tasks";
 if (value === "assignor" || value === "assignment-center") return "assignor";
 if (value === "executive" || value === "executive-overview") return "executive";
  if (value === "departmental" || value === "departmental-overview") return "departmental";
 return null;
}

interface AccessSource {
 platformRole: unknown;
 isAdmin: unknown;
 grantedModulePaths: readonly string[];
 roles: readonly Role[];
}

export function isPlatformAdministrator(role: unknown, flag: unknown): boolean {
 return role === "ADMIN" || flag === true || flag === 1 || flag === "1";
}

/** Navigation/read access is separate from permission to create or change work. */
export function resolveWorkspaceReadAccess(source: AccessSource): { workspaces: Workspace[]; allDepartments: boolean } {
 const admin = isPlatformAdministrator(source.platformRole, source.isAdmin);
 if (admin) return { workspaces: ["assignor", "my-tasks", "executive", "departmental"], allDepartments: true };
 const access = new Set<Workspace>(["my-tasks"]);
 if (source.roles.includes("GLOBAL_ASSIGNOR") || source.roles.includes("DEPARTMENT_ASSIGNOR")) access.add("assignor");
 if (source.roles.includes("EXECUTIVE_VIEWER")) access.add("executive");
  if (source.roles.includes("DEPARTMENT_ASSIGNOR")) access.add("departmental");
  for (const rawPath of source.grantedModulePaths) {
   const path = rawPath.trim().replace(/\/+$/, "");
   // A generic parent-module grant is NOT an executive/global-work capability.
   if ([workspacePath("assignor"), `${ROOT}/assignor`].includes(path)) access.add("assignor");
   if ([workspacePath("executive"), `${ROOT}/executive`].includes(path)) access.add("executive");
    if ([workspacePath("departmental"), `${ROOT}/departmental-overview`].includes(path)) access.add("departmental");
 }
 return { workspaces: [...access], allDepartments: source.roles.includes("GLOBAL_ASSIGNOR") };
}

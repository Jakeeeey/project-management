import { redirect } from "next/navigation";
import { liveBootstrap } from "@/modules/project-management/work-management/assignment-center/server";
import type { Workspace } from "@/modules/project-management/work-management/assignment-center/types";
import { workspacePath } from "@/modules/project-management/work-management/assignment-center/workspace-access";

export const dynamic = "force-dynamic";
export default async function Page() {
 let destination: Workspace = "my-tasks";
  try {
   const { capabilities, workspace_access } = await liveBootstrap();
   destination = workspace_access?.includes("assignor") || capabilities.assign ? "assignor" : capabilities.executive ? "executive" : "my-tasks";
  } catch {
   // Route/session access is handled by the shared middleware, just like sibling
   // modules. Let the workspace show bootstrap errors instead of redirecting to
   // /login, whose existing signed-in redirect can bounce this user back home.
  }
 redirect(workspacePath(destination));
}

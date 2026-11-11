import type { NextRequest } from "next/server";
import * as AssignmentCenter from "@/app/api/project-management/work-management/assignor/[[...path]]/route";
import * as MyTasks from "@/app/api/project-management/work-management/assignee/[[...path]]/route";
import * as ExecutiveOverview from "@/app/api/project-management/work-management/executive/[[...path]]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };

async function dispatch(method: "GET" | "POST" | "PATCH", request: NextRequest, context: Context) {
 const workspace = request.nextUrl.searchParams.get("workspace") ?? "my-tasks";
 const handlers = workspace === "assignor" || workspace === "assignment-center"
  ? AssignmentCenter
   : workspace === "executive" || workspace === "executive-overview" || workspace === "departmental" || workspace === "departmental-overview"
   ? ExecutiveOverview
   : MyTasks;
 return handlers[method](request, context);
}

export const GET = (request: NextRequest, context: Context) => dispatch("GET", request, context);
export const POST = (request: NextRequest, context: Context) => dispatch("POST", request, context);
export const PATCH = (request: NextRequest, context: Context) => dispatch("PATCH", request, context);

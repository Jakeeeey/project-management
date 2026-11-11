import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WorkError, requireRule } from "@/modules/project-management/work-management/assignment-center/policies";
import { liveAddComment, liveAmendTask, liveBootstrap, liveCancelOccurrence, liveChangeDeadline, liveCreateTask, liveDownload, liveRead, liveStageUpload, liveSubmitOccurrence, liveTaskLifecycle, liveReleaseBlocker } from "@/modules/project-management/work-management/assignment-center/server";
import type { Workspace } from "@/modules/project-management/work-management/assignment-center/types";
import { addDays } from "@/modules/project-management/work-management/assignment-center/recurrence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };
const date = z.iso.date();
const query = z.object({ from: date.default("2026-01-01"), to: date.default("2026-12-31"), employee: z.string().regex(/^\d+$/).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) });

async function handle(req: NextRequest, ctx: Context) {
 try {
  const mutation = req.method !== "GET";
  if (mutation) {
   let sameOrigin = false;
   try { const origin = new URL(req.headers.get("origin") ?? ""); sameOrigin = origin.host === req.headers.get("host") && origin.protocol === req.nextUrl.protocol; } catch { /* Fail closed. */ }
   requireRule(sameOrigin, 403, "INVALID_ORIGIN", "A same-origin request is required.");
  }
  const path = (await ctx.params).path ?? [];
  if (req.method === "GET" && path.join("/") === "bootstrap") return NextResponse.json({ success: true, data: await liveBootstrap(), mode: "LIVE" }, { headers: { "Cache-Control": "no-store" } });
  const requestedWorkspace = req.nextUrl.searchParams.get("workspace");
   requireRule(!requestedWorkspace || requestedWorkspace === "assignor", 403, "WORKSPACE_MISMATCH", "This endpoint belongs to the assignment-center workspace.");
   const workspace: Workspace = "assignor";
  if (req.method === "GET" && path[0] === "files" && path[2] === "download") return await liveDownload(path[1], workspace);
  if (req.method === "GET") {
   const period = query.parse(Object.fromEntries(req.nextUrl.searchParams));
   requireRule(period.to >= period.from && period.to <= addDays(period.from, 366), 422, "DATE_RANGE", "Choose a reporting period of at most 367 days.");
   return NextResponse.json({ success: true, data: await liveRead(path, workspace, period), mode: "LIVE" }, { headers: { "Cache-Control": "no-store" } });
  }
  if (req.method === "POST" && path.join("/") === "tasks") return NextResponse.json({ success: true, data: await liveCreateTask(await req.json(), req.headers.get("Idempotency-Key") ?? "", workspace), mode: "LIVE" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  if (req.method === "POST" && path[0] === "occurrences" && /^\d+$/.test(path[1] ?? "") && path[2] === "comments") return NextResponse.json({ success: true, data: await liveAddComment(path[1], await req.json(), req.headers.get("Idempotency-Key") ?? "", workspace), mode: "LIVE" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  if (req.method === "POST" && path[0] === "occurrences" && /^\d+$/.test(path[1] ?? "") && path[2] === "cancel") return NextResponse.json({ success: true, data: await liveCancelOccurrence(path[1], await req.json(), req.headers.get("Idempotency-Key") ?? "", workspace), mode: "LIVE" }, { headers: { "Cache-Control": "no-store" } });
  if (req.method === "PATCH" && path[0] === "occurrences" && /^\d+$/.test(path[1] ?? "") && path[2] === "deadline") return NextResponse.json({ success: true, data: await liveChangeDeadline(path[1], await req.json(), req.headers.get("Idempotency-Key") ?? "", workspace), mode: "LIVE" }, { headers: { "Cache-Control": "no-store" } });
  if (req.method === "PATCH" && path[0] === "tasks" && /^\d+$/.test(path[1] ?? "") && path.length === 2) return NextResponse.json({ success: true, data: await liveAmendTask(path[1], await req.json(), req.headers.get("Idempotency-Key") ?? "", workspace), mode: "LIVE" }, { headers: { "Cache-Control": "no-store" } });
  if (req.method === "POST" && path[0] === "tasks" && /^\d+$/.test(path[1] ?? "") && ["pause", "resume", "cancel", "archive"].includes(path[2] ?? "")) return NextResponse.json({ success: true, data: await liveTaskLifecycle(path[1], path[2], await req.json(), req.headers.get("Idempotency-Key") ?? "", workspace), mode: "LIVE" }, { headers: { "Cache-Control": "no-store" } });
  if (req.method === "POST" && path.join("/") === "uploads/stage") {
   requireRule(req.headers.get("content-length") === null || Number(req.headers.get("content-length")) <= 5 * 1024 * 1024 + 64 * 1024, 413, "FILE_TOO_LARGE", "Each attachment must be no larger than 5 MB.");
   const form = await req.formData(); const file = form.get("file");
   requireRule(file instanceof File, 422, "FILE_REQUIRED", "Choose a file to upload.");
   return NextResponse.json({ success: true, data: await liveStageUpload(file, workspace), mode: "LIVE" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }
  if (req.method === "POST" && path[0] === "occurrences" && /^\d+$/.test(path[1] ?? "") && path[2] === "submissions") return NextResponse.json({ success: true, data: await liveSubmitOccurrence(path[1], await req.json(), req.headers.get("Idempotency-Key") ?? "", workspace), mode: "LIVE" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  return await liveReleaseBlocker();
 } catch (error) {
  if (error instanceof WorkError) return NextResponse.json({ success: false, message: error.message, code: error.code }, { status: error.status });
  if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ success: false, message: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") : "Invalid JSON.", code: "VALIDATION_FAILED" }, { status: 422 });
  console.error("[work-management] Request failed", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ success: false, message: "Work Management request failed. No business command was committed.", code: "INTERNAL_ERROR" }, { status: 500 });
 }
}
export { handle as GET, handle as POST, handle as PATCH };

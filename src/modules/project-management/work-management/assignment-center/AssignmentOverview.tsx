"use client";

import { ClipboardList } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { OverviewProps } from "./workspace-types";
import { assignmentAvailability } from "./availability";

export function AssignmentOverview({ bootstrap, rows, onOpen }: OverviewProps) {
 const availability = bootstrap ? assignmentAvailability(bootstrap) : null;
 const tasks = new Set(rows.map(row => row.task_id));
 const people = new Set(rows.map(row => row.assignee.id));
 return <section aria-label="Task assignment workspace" className="space-y-3">
  <Card><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="size-4" />Assigned tasks</CardTitle></CardHeader><CardContent className="space-y-3">
   <p className="text-sm text-muted-foreground">{tasks.size} task definitions · {people.size} employees · {rows.length} individual obligations. Select a task to review submissions or manage its assignment.</p>
   <div className="divide-y rounded-lg border">{[...new Set(rows.map(row => row.task_id))].map(taskId => {
    const obligations = rows.filter(row => row.task_id === taskId);
    const first = obligations[0];
    const submitted = obligations.filter(row => !!row.first_submission_id).length;
    return <button key={taskId} type="button" onClick={() => onOpen(first.id)} className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-muted/50">
     <span><span className="block text-sm font-medium">{first.task_revision.title}</span><span className="text-xs text-muted-foreground">{new Set(obligations.map(row => row.assignee.name)).size} assignees · {submitted} submitted · {obligations.length} obligations</span></span>
     <span className="text-xs text-primary underline">Open task</span>
    </button>;
   })}{!rows.length && <p className="p-4 text-sm text-muted-foreground">No tasks in this period.</p>}</div>
   {availability && !availability.canSave && <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><p className="font-medium">You can review assignment details; saving is unavailable for your account.</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{availability.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><p className="mt-2 text-xs">Use <strong>Create &amp; Assign Task</strong> to review employee selection, reporting, and recurrence controls.</p></div>}
  </CardContent></Card>
 </section>;
}

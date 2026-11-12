"use client";

import { ClipboardList, Users, CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { OverviewProps } from "./workspace-types";
import { assignmentAvailability } from "./availability";

export function AssignmentOverview({ bootstrap, rows }: OverviewProps) {
 const availability = bootstrap ? assignmentAvailability(bootstrap) : null;
 const tasks = new Set(rows.map(row => row.task_id));
 const people = new Set(rows.map(row => row.assignee.id));
 return <section aria-label="Task assignment workspace" className="space-y-3">
  <div className="grid gap-3 md:grid-cols-3">
   {[
    { icon: ClipboardList, title: "1. Define the task", text: "Write instructions, choose priority, and attach reference materials." },
    { icon: Users, title: "2. Select employees", text: "Assign to multiple people. Each employee receives their own obligation." },
    { icon: CalendarClock, title: "3. Set deadlines & follow up", text: "Choose one-time or recurring work, then track submissions by employee." },
   ].map(({ icon: Icon, title, text }) => <Card key={title}><CardContent className="flex gap-3 p-4"><Icon className="mt-0.5 size-5 shrink-0 text-primary" /><div><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-xs text-muted-foreground">{text}</p></div></CardContent></Card>)}
  </div>
  <Card><CardHeader className="pb-2"><CardTitle className="text-base">Team assignment overview</CardTitle></CardHeader><CardContent className="space-y-3">
   <p className="text-sm text-muted-foreground">Manage work assigned to your team—not your personal Submission Bin. Current loaded period/page: <strong>{tasks.size} task definitions</strong> · <strong>{people.size} employees</strong> · <strong>{rows.length} individual obligations</strong>.</p>
<<<<<<< HEAD
   {availability && !availability.canSave && <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><p className="font-medium">You can review assignment details; saving is unavailable for your account.</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{availability.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><p className="mt-2 text-xs">Use <strong>Create &amp; Assign Task</strong> to review employee selection, reporting, and recurrence controls.</p></div>}
=======
   {availability && !availability.canSave && <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><p className="font-medium">Assignment form is available to preview; saving is unavailable.</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{availability.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><p className="mt-2 text-xs">Use <strong>Create &amp; Assign Task</strong> to inspect employee selection, reporting, and recurrence controls. Previewing does not create assignments.</p></div>}
>>>>>>> origin
  </CardContent></Card>
 </section>;
}

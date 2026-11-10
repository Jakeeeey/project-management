"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Assignment, Bootstrap, Frequency, Task, WorkFile } from "./types";
import { localDate } from "./recurrence";
import type { WorkApi } from "./workspace-types";
import { assignmentAvailability } from "./availability";
import { validateTaskTiming } from "./task-timing";

export function useTaskForm({ task, bootstrap, api, onSaved }: {
 task: Task | null; bootstrap: Bootstrap; api: WorkApi; onSaved: () => void;
}) {
 const [title, setTitle] = useState(task?.title ?? ""); const [description, setDescription] = useState(task?.description ?? "");
 const [scope, setScope] = useState<"DEPARTMENT" | "GLOBAL">(task?.scope_type ?? "DEPARTMENT");
 const initialDepartment = task?.department_id ?? (bootstrap.actor.department_id || ((bootstrap.capabilities.global || bootstrap.actor.read_all_departments) ? bootstrap.employees.find(employee => employee.department_id)?.department_id : "") || "");
 const [dept, setDept] = useState(initialDepartment);
 const [assignees, setAssignees] = useState<string[]>([]); const [personSearch, setPersonSearch] = useState("");
 const [report, setReport] = useState(task?.report_to_user_id ?? ""); const [priority, setPriority] = useState(task?.priority ?? "NORMAL");
 const [frequency, setFrequency] = useState<Frequency>(task?.schedule.frequency ?? "ONCE");
 const [start, setStart] = useState(task?.schedule.start_date ?? localDate(new Date())); const [end, setEnd] = useState(task?.schedule.end_date ?? "");
 const [time, setTime] = useState(task?.schedule.due_local_time.slice(0, 5) ?? "17:00"); const [interval, setIntervalValue] = useState(task?.schedule.interval_value ?? 1);
 const [unit, setUnit] = useState<"DAY" | "WEEK" | "MONTH">(task?.schedule.interval_unit ?? "DAY");
 const [weekdays, setWeekdays] = useState<number[]>(task?.schedule.days_of_week ?? [5]); const [monthday, setMonthday] = useState(task?.schedule.day_of_month ?? 1);
 const [monthEnd, setMonthEnd] = useState<"CLAMP_TO_LAST_DAY" | "SKIP">(task?.schedule.month_end_policy ?? "CLAMP_TO_LAST_DAY");
 const [availability, setAvailability] = useState(task ? new Date(new Date(task.availability_start_at).getTime() + 8 * 3600000).toISOString().slice(0, 16) : `${localDate(new Date())}T00:00`);
 const [references, setReferences] = useState<File[]>([]); const [reason, setReason] = useState("");
 const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [ready, setReady] = useState(!task);
 const request = useRef<{ key: string; body: string } | null>(null);
 useEffect(() => {
  if (!task) return;
  let active = true;
  api<Assignment[]>(`tasks/${task.id}/assignments`).then(assignments => {
   if (active) { setAssignees(assignments.filter(a => a.status === "ACTIVE").map(a => a.assignee_user_id)); setReady(true); }
  }).catch(error => { if (active) setError(String(error)); });
  return () => { active = false; };
 }, [api, task]);
 const people = bootstrap.employees.filter(employee => (scope === "GLOBAL" || employee.department_id === dept) && employee.name.toLowerCase().includes(personSearch.toLowerCase()));
 const save = async (event: FormEvent) => {
  event.preventDefault();
  const assignmentStatus = assignmentAvailability(bootstrap);
  if (!assignmentStatus.canSave) { setError(assignmentStatus.reasons.join(" ")); return; }
   if (bootstrap.reference_uploads_enabled !== true && references.length) { setError("Reference uploads are not enabled for this workspace."); return; }
  setBusy(true); setError("");
  try {
   // Validate before staging files or issuing any business write. This uses the
   // selected datetime-local string, not the assignment-permissions object.
   const timing = validateTaskTiming(start, time, availability, frequency === "ONCE" ? "" : end);
   const fileIds = [...(task?.reference_file_ids ?? [])];
   for (const file of references) { const data = new FormData(); data.append("file", file); const upload = await api<WorkFile>("uploads/stage", { method: "POST", body: data }); fileIds.push(upload.id); }
   const payload = {
    title, description, scope_type: scope, department_id: dept, assignee_user_ids: assignees, report_to_user_id: report || undefined, priority,
    availability_start_at: timing.availability_start_at, reference_file_ids: fileIds,
    schedule: { frequency, interval_value: frequency === "ONCE" ? 1 : interval, interval_unit: frequency === "CUSTOM" ? unit : undefined, days_of_week: frequency === "WEEKLY" || frequency === "CUSTOM" && unit === "WEEK" ? weekdays : [], day_of_month: frequency === "MONTHLY" || frequency === "CUSTOM" && unit === "MONTH" ? monthday : undefined, month_end_policy: monthEnd, due_local_time: time, timezone: "Asia/Manila", start_date: start, end_date: end || undefined },
    ...(task ? { expected_revision: task.revision_number, reason } : {}),
   };
   const body = JSON.stringify(payload);
   if (!request.current || request.current.body !== body) request.current = { key: crypto.randomUUID(), body };
   await api(task ? `tasks/${task.id}` : "tasks", { method: task ? "PATCH" : "POST", headers: { "Idempotency-Key": request.current.key }, body });
   request.current = null;
   onSaved();
  } catch (error) { setError(error instanceof Error ? error.message : "Unable to save task."); }
  finally { setBusy(false); }
 };
 return { title, setTitle, description, setDescription, scope, setScope, dept, setDept, assignees, setAssignees, personSearch, setPersonSearch, report, setReport, priority, setPriority, frequency, setFrequency, start, setStart, end, setEnd, time, setTime, interval, setIntervalValue, unit, setUnit, weekdays, setWeekdays, monthday, setMonthday, monthEnd, setMonthEnd, availability, setAvailability, setReferences, reason, setReason, error, busy, ready, people, save };
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays as shiftDay, endOfMonth, format, startOfMonth, startOfWeek } from "date-fns";
<<<<<<< HEAD
import { CalendarDays, ChevronLeft, ChevronRight, CircleAlert, Loader2, Search } from "lucide-react";
=======
import { Bell, CalendarDays, ChevronLeft, ChevronRight, CircleAlert, RefreshCw, Search } from "lucide-react";
>>>>>>> origin
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { NavUser } from "@/components/shared/app-sidebar/nav-user";
import { cn } from "@/lib/utils";
<<<<<<< HEAD
<<<<<<<< HEAD:src/modules/project-management/work-management/my-tasks/WorkWorkspace.tsx
import type { Bootstrap, Detail, Employee, OccurrenceView, Summary, Task, Workspace } from "./types";
========
import type { Bootstrap, Detail, Employee, Notification, OccurrenceView, Summary, Task, Workspace } from "./types";
>>>>>>>> origin:src/modules/project-management/work-management/assignment-center/WorkWorkspace.tsx
=======
import type { Bootstrap, Detail, Employee, Notification, OccurrenceView, Summary, Task, Workspace } from "./types";
>>>>>>> origin
import { localDate } from "./recurrence";
import type { HeaderAccount, WorkspaceDefinition, DashboardData } from "./workspace-types";
import { SubmissionBin } from "./SubmissionBin";
import { useSubmission } from "./useSubmission";
import { TaskForm } from "./TaskForm";
import { frequencyLabels, selectClass } from "./presentation";

<<<<<<< HEAD
<<<<<<<< HEAD:src/modules/project-management/work-management/my-tasks/WorkWorkspace.tsx
const BASE = "/api/project-management/work-management/assignee";
========
const BASE = "/api/project-management/work-management/assignor";
>>>>>>>> origin:src/modules/project-management/work-management/assignment-center/WorkWorkspace.tsx
=======
const BASE = "/api/project-management/work-management/assignee";
>>>>>>> origin
const dateTime = (date: string) => new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }).format(new Date(date));
function stateOf(o: OccurrenceView) {
 if (o.status === "CANCELLED") return "Cancelled";
 if (o.first_submission_id) return o.submissions.find(s => s.id === o.first_submission_id)?.is_late ? "Submitted late" : "Submitted on time";
 if (o.due_at < new Date().toISOString()) return "Overdue";
 return o.available_at > new Date().toISOString() ? "Upcoming" : "Available";
}
const stateClass = (state: string) => state === "Submitted on time" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : state === "Submitted late" ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300" : state === "Overdue" ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300" : state === "Available" ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300" : "border-border bg-muted text-muted-foreground";

function Stats({ summary, label }: { summary: Summary; label: string }) {
 const percent = summary.due ? Math.round(summary.submitted / summary.due * 100) : 0;
 return <section aria-label={label} className="space-y-3">
  <h2 className="text-sm font-semibold">{label}</h2>
  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[["Due this period", summary.due], ["Submitted", summary.submitted], ["Overdue in period", summary.overdue], ["On-time / due", `${summary.on_time} / ${summary.due}`]].map(([caption, value]) => <Card key={caption}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{caption}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p></CardContent></Card>)}</div>
  <Card><CardContent className="space-y-2 p-4"><div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-medium">{summary.due ? `${summary.submitted} of ${summary.due} submitted (${percent}%)` : "No obligations due this period"}</span><span className="text-muted-foreground">{summary.backlog} open overdue from earlier periods</span></div>
   <div role="progressbar" aria-label="Submission completion" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="flex h-3 overflow-hidden rounded-full bg-muted"><div className="bg-emerald-500 transition-all" style={{ width: `${summary.due ? summary.on_time / summary.due * 100 : 0}%` }} /><div className="bg-amber-500 transition-all" style={{ width: `${summary.due ? (summary.submitted - summary.on_time) / summary.due * 100 : 0}%` }} /></div>
   <p className="text-xs text-muted-foreground">Green: first submission on time · Amber: first submission late · Cancelled obligations excluded</p>
  </CardContent></Card>
 </section>;
}

export function WorkWorkspace({ definition, account }: { definition: WorkspaceDefinition; account: HeaderAccount }) {
  const { workspace, Actions, Dashboard, Overview } = definition;
 const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
 const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
<<<<<<< HEAD
 const [loadedKey, setLoadedKey] = useState("");
=======
>>>>>>> origin
 const [date, setDate] = useState(() => localDate(new Date()));
 const [calendarMode, setCalendarMode] = useState<"Month" | "Week" | "Day">("Month");
 const [view, setView] = useState(definition.initialView ?? "Calendar"); const [search, setSearch] = useState("");
 const [employee, setEmployee] = useState(""); const [status, setStatus] = useState("");
 const [priority, setPriority] = useState(""); const [recurrence, setRecurrence] = useState("");
 const [department, setDepartment] = useState(""); const [more, setMore] = useState(false);
 const [items, setItems] = useState<OccurrenceView[]>([]); const [summary, setSummary] = useState<Summary | null>(null);
 const [total, setTotal] = useState(0); const [page, setPage] = useState(1);
  const [dashboardData, setDashboardData] = useState<DashboardData>({ employees: [], trends: [] });
  const bootstrapCache = useRef<Bootstrap | null>(null);
<<<<<<< HEAD
<<<<<<<< HEAD:src/modules/project-management/work-management/my-tasks/WorkWorkspace.tsx
 const directoryCache = useRef<Employee[] | null>(null);
========
>>>>>>>> origin:src/modules/project-management/work-management/assignment-center/WorkWorkspace.tsx
 const [selected, setSelected] = useState<string | null>(null); const [day, setDay] = useState<string | null>(null);
 const [form, setForm] = useState<Task | "new" | null>(null);
=======
 const [selected, setSelected] = useState<string | null>(null); const [day, setDay] = useState<string | null>(null);
 const [form, setForm] = useState<Task | "new" | null>(null);
 const [notifications, setNotifications] = useState<Notification[]>([]); const [notificationsOpen, setNotificationsOpen] = useState(false);
>>>>>>> origin
 const [version, setVersion] = useState(0);
 const anchor = new Date(`${date}T12:00:00`);
 const from = format(calendarMode === "Month" ? startOfMonth(anchor) : calendarMode === "Week" ? startOfWeek(anchor, { weekStartsOn: 1 }) : anchor, "yyyy-MM-dd");
  const to = calendarMode === "Month" ? format(endOfMonth(anchor), "yyyy-MM-dd") : calendarMode === "Week" ? format(shiftDay(new Date(from + "T12:00:00"), 6), "yyyy-MM-dd") : from;
  const executiveDirectory = workspace === "executive" && !employee;
<<<<<<< HEAD
 const wantsDirectory = definition.views.includes("By Employee");
 const queryKey = `${workspace}|${view}|${from}|${to}|${page}|${employee}`;
 const stale = loading && loadedKey !== queryKey;
=======
>>>>>>> origin
 const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${BASE}/${path}${path.includes("?") ? "&" : "?"}workspace=${workspace}`, { cache: "no-store", ...init, headers: { ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init?.headers } });
  const body = await response.json(); if (!response.ok) throw new Error(body.message ?? "Request failed"); return body.data as T;
 }, [workspace]);
 const refresh = useCallback(() => setVersion(v => v + 1), []);
 useEffect(() => {
  let active = true; setLoading(true); setError("");
  (async () => {
   try {
     const q = new URLSearchParams({ from, to, page: String(page), limit: "100", ...(employee ? { employee } : {}) });
     const bootRequest = bootstrapCache.current ? Promise.resolve(bootstrapCache.current) : api<Bootstrap>("bootstrap");
<<<<<<< HEAD
<<<<<<<< HEAD:src/modules/project-management/work-management/my-tasks/WorkWorkspace.tsx
     const directoryRequest = wantsDirectory ? directoryCache.current ? Promise.resolve(directoryCache.current) : api<Employee[]>("directory").catch(() => null) : Promise.resolve(null);
     const needsCalendar = !executiveDirectory;
     const alternateRoute = view === "Backlog" ? "occurrences/backlog" : null;
     const alternateQuery = view === "Backlog" ? new URLSearchParams({ from: format(shiftDay(new Date(), -366), "yyyy-MM-dd"), to: localDate(new Date()), page: String(page), limit: "100" }) : q;
     const calendarRequest = needsCalendar ? api<{ items: OccurrenceView[]; total: number; summary: Summary }>(`occurrences/calendar?${q}`) : Promise.resolve(null);
     const displayRequest = needsCalendar && alternateRoute ? api<{ items: OccurrenceView[]; total: number }>(`${alternateRoute}?${alternateQuery}`) : Promise.resolve(null);
     const reuseExecutiveMetrics = workspace === "executive" && !!employee;
     const dashboardRequest = definition.loadDashboard && !reuseExecutiveMetrics ? definition.loadDashboard(api, q) : Promise.resolve(null);
     const [boot, data, alternate, dashboard, directory] = await Promise.all([bootRequest, calendarRequest, displayRequest, dashboardRequest, directoryRequest]);
     if (!active) return;
     setLoadedKey(queryKey);
========
=======
>>>>>>> origin
     const needsCalendar = !executiveDirectory;
     const alternateRoute = view === "For review" ? "reviews" : view === "Backlog" ? "occurrences/backlog" : null;
     const calendarRequest = needsCalendar ? api<{ items: OccurrenceView[]; total: number; summary: Summary }>(`occurrences/calendar?${q}`) : Promise.resolve(null);
     const displayRequest = needsCalendar && alternateRoute ? api<{ items: OccurrenceView[]; total: number }>(`${alternateRoute}?${q}`) : Promise.resolve(null);
     const reuseExecutiveMetrics = workspace === "executive" && !!employee;
     const dashboardRequest = definition.loadDashboard && !reuseExecutiveMetrics ? definition.loadDashboard(api, q) : Promise.resolve(null);
     const [boot, data, alternate, dashboard] = await Promise.all([bootRequest, calendarRequest, displayRequest, dashboardRequest]);
     if (!active) return;
<<<<<<< HEAD
>>>>>>>> origin:src/modules/project-management/work-management/assignment-center/WorkWorkspace.tsx
=======
>>>>>>> origin
     bootstrapCache.current = boot;
     setBootstrap(boot);
     if (data) setSummary(data.summary);
     const display = alternate ?? data;
     if (display) { setItems(display.items); setTotal(display.total); }
<<<<<<< HEAD
<<<<<<<< HEAD:src/modules/project-management/work-management/my-tasks/WorkWorkspace.tsx
     if (directory) directoryCache.current = directory;
     const knownEmployees = new Map([...(directory ?? []), ...boot.employees].map(person => [person.id, person]));
========
     const knownEmployees = new Map(boot.employees.map(person => [person.id, person]));
>>>>>>>> origin:src/modules/project-management/work-management/assignment-center/WorkWorkspace.tsx
=======
     const knownEmployees = new Map(boot.employees.map(person => [person.id, person]));
>>>>>>> origin
     for (const row of display?.items ?? []) knownEmployees.set(row.assignee.id, row.assignee);
     setBootstrap({ ...boot, employees: [...knownEmployees.values()] });
     if (dashboard && active) setDashboardData(dashboard);
     else if (reuseExecutiveMetrics && data && active) setDashboardData(previous => ({ ...previous, employees: previous.employees.map(person => person.id === employee ? { ...person, ...data.summary } : person) }));
   } catch (e) { if (active) setError(e instanceof Error ? e.message : "Unable to load workspace."); }
   finally { if (active) setLoading(false); }
  })();
  return () => { active = false; };
<<<<<<< HEAD
<<<<<<<< HEAD:src/modules/project-management/work-management/my-tasks/WorkWorkspace.tsx
  }, [api, from, to, page, employee, version, workspace, view, definition, executiveDirectory, wantsDirectory, queryKey]);
========
  }, [api, from, to, page, employee, version, workspace, view, definition, executiveDirectory]);
>>>>>>>> origin:src/modules/project-management/work-management/assignment-center/WorkWorkspace.tsx
 useEffect(() => { const timer = setInterval(refresh, 30000); window.addEventListener("focus", refresh); return () => { clearInterval(timer); window.removeEventListener("focus", refresh); }; }, [refresh]);
 const searchTokens = useMemo(() => search.trim().toLowerCase().split(/\s+/).filter(Boolean), [search]);
 const matchesSearch = useCallback((value: string) => !searchTokens.length || searchTokens.every(token => value.toLowerCase().includes(token)), [searchTokens]);
 const baseFiltered = useMemo(() => items.filter(o => (!status || stateOf(o) === status) && (!priority || o.task_revision.priority === priority) && (!recurrence || o.task_revision.schedule.frequency === recurrence) && (!department || o.assignee.department_id === department)), [items, status, priority, recurrence, department]);
 const filtered = useMemo(() => baseFiltered.filter(o => matchesSearch(`${o.task.title} ${o.assignee.name}`)), [baseFiltered, matchesSearch]);
 const byEmployee = useMemo(() => {
  const nameScore = (name: string) => {
   if (!searchTokens.length) return 0;
   const normalized = name.toLowerCase();
   if (!searchTokens.every(token => normalized.includes(token))) return -1;
   const phrase = searchTokens.join(" ");
   if (normalized === phrase) return 1000;
   if (normalized.startsWith(phrase)) return 900;
   return 500 - Math.min(Math.min(...searchTokens.map(token => normalized.indexOf(token))), 400);
  };
  const directory = new Map((bootstrap?.employees ?? []).map(employee => [employee.id, employee]));
  for (const row of baseFiltered) if (!directory.has(row.assignee.id)) directory.set(row.assignee.id, row.assignee);
  const group = (rows: OccurrenceView[]) => rows.reduce((map, row) => { map.set(row.assignee.id, [...(map.get(row.assignee.id) ?? []), row]); return map; }, new Map<string, OccurrenceView[]>());
  const allRows = group(baseFiltered);
  const matchingRows = group(filtered);
  const entries = [...directory.values()].map(employee => ({ employee, score: nameScore(employee.name) }));
  // A search that names employees shows only those employees, with all of their obligations; unrelated names are hidden.
  const nameMatches = entries.filter(entry => entry.score >= 0).sort((a, b) => b.score - a.score || a.employee.name.localeCompare(b.employee.name));
  if (searchTokens.length && nameMatches.length) return nameMatches.map(({ employee, score }) => ({ employee, score, rows: allRows.get(employee.id) ?? [] }));
  if (searchTokens.length) return entries.map(entry => ({ ...entry, rows: matchingRows.get(entry.employee.id) ?? [] })).filter(entry => entry.rows.length > 0).sort((a, b) => b.rows.length - a.rows.length || a.employee.name.localeCompare(b.employee.name));
  return entries.map(entry => ({ ...entry, rows: allRows.get(entry.employee.id) ?? [] })).sort((a, b) => a.employee.name.localeCompare(b.employee.name));
 }, [bootstrap, baseFiltered, filtered, searchTokens]);
 const clear = () => { setSearch(""); setEmployee(""); setStatus(""); setPriority(""); setRecurrence(""); setDepartment(""); setPage(1); };
 const navigate = (direction: number) => { const d = new Date(date + "T12:00:00"); if (calendarMode === "Month") { d.setDate(1); d.setMonth(d.getMonth() + direction); } else d.setDate(d.getDate() + direction * (calendarMode === "Week" ? 7 : 1)); setDate(format(d, "yyyy-MM-dd")); setPage(1); };
 const dayCells = calendarMode === "Month" ? Array.from({ length: 42 }, (_, i) => format(shiftDay(startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }), i), "yyyy-MM-dd")) : calendarMode === "Week" ? Array.from({ length: 7 }, (_, i) => format(shiftDay(new Date(from + "T12:00:00"), i), "yyyy-MM-dd")) : [date];

  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-2 sm:px-4"><div className="flex min-w-0 items-center gap-3"><SidebarTrigger /><span className="hidden truncate text-sm text-muted-foreground sm:inline">Project Management /</span><span className="truncate text-sm font-medium">Work Management</span></div><div className="flex h-full shrink-0 items-center gap-1"><div className="flex h-full max-w-[48vw] items-center overflow-hidden pl-1 sm:max-w-none sm:pl-2"><NavUser user={account} /></div></div></header>
=======
  }, [api, from, to, page, employee, version, workspace, view, definition, executiveDirectory]);
 useEffect(() => { const timer = setInterval(refresh, 30000); window.addEventListener("focus", refresh); return () => { clearInterval(timer); window.removeEventListener("focus", refresh); }; }, [refresh]);
 const filtered = useMemo(() => items.filter(o => (!search || `${o.task_revision.title} ${o.assignee.name}`.toLowerCase().includes(search.toLowerCase())) && (!status || stateOf(o) === status) && (!priority || o.task_revision.priority === priority) && (!recurrence || o.task_revision.schedule.frequency === recurrence) && (!department || o.assignee.department_id === department)), [items, search, status, priority, recurrence, department]);
 const clear = () => { setSearch(""); setEmployee(""); setStatus(""); setPriority(""); setRecurrence(""); setDepartment(""); setPage(1); };
 const navigate = (direction: number) => { const d = new Date(date + "T12:00:00"); if (calendarMode === "Month") { d.setDate(1); d.setMonth(d.getMonth() + direction); } else d.setDate(d.getDate() + direction * (calendarMode === "Week" ? 7 : 1)); setDate(format(d, "yyyy-MM-dd")); setPage(1); };
 const dayCells = calendarMode === "Month" ? Array.from({ length: 42 }, (_, i) => format(shiftDay(startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }), i), "yyyy-MM-dd")) : calendarMode === "Week" ? Array.from({ length: 7 }, (_, i) => format(shiftDay(new Date(from + "T12:00:00"), i), "yyyy-MM-dd")) : [date];
 const openNotifications = async () => { try { setNotifications(await api<Notification[]>("notifications")); setNotificationsOpen(true); } catch (e) { setError(String(e)); } };

  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-2 sm:px-4"><div className="flex min-w-0 items-center gap-3"><SidebarTrigger /><span className="hidden truncate text-sm text-muted-foreground sm:inline">Project Management /</span><span className="truncate text-sm font-medium">Work Management</span></div><div className="flex h-full shrink-0 items-center gap-1"><Button variant="ghost" size="icon" aria-label="Refresh workspace" onClick={refresh}><RefreshCw className={cn("size-4", loading && "animate-spin")} /></Button><Button variant="ghost" size="icon" aria-label="Notifications" onClick={openNotifications}><Bell className="size-4" /></Button><div className="flex h-full max-w-[48vw] items-center overflow-hidden pl-1 sm:max-w-none sm:pl-2"><NavUser user={account} /></div></div></header>
>>>>>>> origin
 <main className="flex-1 space-y-5 overflow-y-auto p-4 md:p-6">
 <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Work Management · Asia/Manila</p><h1 className="text-2xl font-semibold tracking-tight">{definition.title}</h1><p className="mt-1 text-sm text-muted-foreground">{definition.description}</p></div>{Actions && <Actions bootstrap={bootstrap} onCreate={() => setForm("new")} />}</div>
   {bootstrap?.mode === "LIVE" && bootstrap.writes_enabled === false && <div role="status" className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">Work items are available for viewing. Changes are not enabled for this account.</div>}
 {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"><div className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" /><div><h2 className="font-medium">Workspace unavailable</h2><p className="mt-1 text-sm">{error}</p><Button variant="outline" size="sm" className="mt-3" onClick={refresh}>Retry</Button></div></div></div>}
 {!error && <>{loading && !summary ? <div role="status" className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map(i => <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />)}<span className="sr-only">Loading workspace</span></div> : summary && <Stats summary={summary} label={definition.progressLabel ?? "Submission progress"} />}
<<<<<<< HEAD
 {Overview && <Overview bootstrap={bootstrap} rows={filtered} onCreate={() => setForm("new")} onOpen={setSelected} />}
=======
 {Overview && <Overview bootstrap={bootstrap} rows={filtered} onCreate={() => setForm("new")} />}
>>>>>>> origin
  {executiveDirectory && <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Button size="icon" variant="outline" aria-label="Previous period" onClick={() => navigate(-1)}><ChevronLeft className="size-4" /></Button><Button size="icon" variant="outline" aria-label="Next period" onClick={() => navigate(1)}><ChevronRight className="size-4" /></Button><Button variant="outline" onClick={() => { setDate(localDate(new Date())); setPage(1); }}>Today</Button><label><span className="sr-only">Reporting date</span><input aria-label="Reporting date" type="date" className={selectClass} value={date} onChange={e => { if (e.target.value) { setDate(e.target.value); setPage(1); } }} /></label></div><span className="text-sm font-medium">{format(anchor, "MMMM yyyy")}</span></div>}
  {Dashboard && <Dashboard data={dashboardData} selectedEmployee={employee} periodLabel={`${from} – ${to}`} onSelectEmployee={id => { setEmployee(id); setPage(1); }} onClearEmployee={() => { setEmployee(""); setPage(1); }} />}
  {!executiveDirectory && <Card><CardContent className="space-y-4 p-3 md:p-5">
 {definition.views.length > 1 && <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 w-fit">{definition.views.map(v => <Button key={v} size="sm" variant={view === v ? "secondary" : "ghost"} onClick={() => { setView(v); setPage(1); }}>{v}</Button>)}</div>}
  <div className="flex flex-wrap gap-2"><div className="relative min-w-44 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Search tasks or employees" placeholder="Search tasks or employees…" className="pl-9" value={search} onChange={e => setSearch(e.target.value)} /></div>{workspace !== "my-tasks" && workspace !== "executive" && <select aria-label="Employee" className={selectClass} value={employee} onChange={e => { setEmployee(e.target.value); setPage(1); }}><option value="">All employees</option>{bootstrap?.employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select>}<select aria-label="Status" className={selectClass} value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{["Upcoming", "Available", "Submitted on time", "Submitted late", "Overdue", "Cancelled"].map(s => <option key={s}>{s}</option>)}</select><Button variant="outline" onClick={() => setMore(v => !v)}>More filters</Button><Button variant="ghost" onClick={clear}>Clear filters</Button></div>
 {more && <div className="flex flex-wrap gap-2 rounded-lg border p-3"><select className={selectClass} aria-label="Priority" value={priority} onChange={e => setPriority(e.target.value)}><option value="">All priorities</option>{["LOW", "NORMAL", "HIGH", "CRITICAL"].map(p => <option key={p}>{p}</option>)}</select><select className={selectClass} aria-label="Recurrence" value={recurrence} onChange={e => setRecurrence(e.target.value)}><option value="">All schedules</option>{Object.entries(frequencyLabels).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select><select className={selectClass} aria-label="Department" value={department} onChange={e => setDepartment(e.target.value)}><option value="">All departments</option>{[...new Map(bootstrap?.employees.map(e => [e.department_id, e.department])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><p className="w-full text-xs text-muted-foreground">Visual filters apply to this loaded page; KPI cards retain the employee and date-period scope.</p></div>}
 <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-1"><Button size="icon" variant="outline" aria-label="Previous period" onClick={() => navigate(-1)}><ChevronLeft className="size-4" /></Button><Button size="icon" variant="outline" aria-label="Next period" onClick={() => navigate(1)}><ChevronRight className="size-4" /></Button><Button variant="outline" onClick={() => { setDate(localDate(new Date())); setPage(1); }}>Today</Button><label className="ml-2"><span className="sr-only">Selected date</span><input type="date" className={selectClass} value={date} onChange={e => { if (e.target.value) { setDate(e.target.value); setPage(1); } }} /></label></div><h2 className="font-medium">{calendarMode === "Month" ? format(anchor, "MMMM yyyy") : `${from} – ${to}`}</h2><div className="flex gap-1">{(["Month", "Week", "Day"] as const).map(mode => <Button size="sm" key={mode} variant={calendarMode === mode ? "secondary" : "ghost"} onClick={() => { setCalendarMode(mode); setPage(1); }}>{mode}</Button>)}</div></div>
<<<<<<< HEAD
 <div className="flex flex-wrap gap-2 text-xs">{[search, employee && bootstrap?.employees.find(e => e.id === employee)?.name, status, priority, recurrence, department && `Department ${department}`].filter(Boolean).map((v, i) => <Badge variant="secondary" key={i}>{v}</Badge>)}{loading ? <span role="status" className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" />Loading obligations…</span> : <span className="text-muted-foreground">{view === "By Employee" ? byEmployee.reduce((count, entry) => count + entry.rows.length, 0) : filtered.length} shown · {total} obligations in period{total > 100 ? " · calendar is paginated" : ""}</span>}</div>
 {stale ? <ListSkeleton /> : view === "Calendar" ? <div className="overflow-x-auto"><div className={cn("min-w-[650px]", calendarMode === "Day" && "min-w-0")}><div className={cn("grid grid-cols-7", calendarMode === "Day" && "grid-cols-1")}>{(calendarMode === "Day" ? [format(anchor, "EEEE")] : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]).map(d => <div key={d} className="border-b p-2 text-xs font-medium text-muted-foreground">{d}</div>)}</div><div className={cn("grid grid-cols-7 border-l", calendarMode === "Day" && "grid-cols-1")}>{dayCells.map(d => { const obligations = filtered.filter(o => localDate(o.due_at) === d); return <div key={d} className={cn("min-h-28 space-y-1 border-b border-r p-1.5", !d.startsWith(from.slice(0, 7)) && calendarMode === "Month" && "bg-muted/30", d === localDate(new Date()) && "bg-primary/5")}><button onClick={() => setDay(d)} aria-label={`Show obligations for ${d}`} className="flex size-7 items-center justify-center rounded-full text-xs font-medium hover:bg-muted focus-visible:outline-2">{Number(d.slice(-2))}</button>{obligations.slice(0, calendarMode === "Day" ? 50 : 2).map(o => <button key={o.id} onClick={() => setSelected(o.id)} className={cn("block w-full truncate rounded border px-1.5 py-1 text-left text-xs focus-visible:outline-2", stateClass(stateOf(o)))} title={`${o.task.title} · ${o.assignee.name} · ${stateOf(o)}`}><span aria-hidden="true">{o.first_submission_id ? "✓ " : stateOf(o) === "Overdue" ? "! " : "• "}</span>{o.task.title}<span className="sr-only"> · {stateOf(o)}</span></button>)}{obligations.length > 2 && calendarMode !== "Day" && <button className="px-1 text-xs text-primary underline" onClick={() => setDay(d)}>+{obligations.length - 2} more</button>}</div>; })}</div></div></div> : view === "By Employee" ? <div className="space-y-4">{byEmployee.map(({ employee, rows, score }) => <section key={employee.id}><h3 className="mb-2 flex items-center gap-2 text-sm font-medium">{employee.name}{searchTokens.length > 0 && score >= 0 && <Badge variant="secondary">Name match</Badge>}</h3><ObligationList rows={rows} onOpen={setSelected} /></section>)}{!byEmployee.length && <p className="p-4 text-sm text-muted-foreground">No employees match “{search}”.</p>}</div> : <ObligationList rows={filtered} onOpen={setSelected} />}
 {!stale && (view === "By Employee" ? !byEmployee.length : !filtered.length) && <div className="py-8 text-center text-sm text-muted-foreground"><CalendarDays className="mx-auto mb-2 size-7" />{searchTokens.length ? "No employees or obligations match your search. Try another name or task title, or clear the filters." : "No obligations match this view. Try another period or clear filters."}</div>}
=======
 <div className="flex flex-wrap gap-2 text-xs">{[search, employee && bootstrap?.employees.find(e => e.id === employee)?.name, status, priority, recurrence, department && `Department ${department}`].filter(Boolean).map((v, i) => <Badge variant="secondary" key={i}>{v}</Badge>)}<span className="text-muted-foreground">{filtered.length} shown · {total} obligations in period{total > 100 ? " · calendar is paginated" : ""}</span></div>
 {view === "Calendar" ? <div className="overflow-x-auto"><div className={cn("min-w-[650px]", calendarMode === "Day" && "min-w-0")}><div className={cn("grid grid-cols-7", calendarMode === "Day" && "grid-cols-1")}>{(calendarMode === "Day" ? [format(anchor, "EEEE")] : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]).map(d => <div key={d} className="border-b p-2 text-xs font-medium text-muted-foreground">{d}</div>)}</div><div className={cn("grid grid-cols-7 border-l", calendarMode === "Day" && "grid-cols-1")}>{dayCells.map(d => { const obligations = filtered.filter(o => localDate(o.due_at) === d); return <div key={d} className={cn("min-h-28 space-y-1 border-b border-r p-1.5", !d.startsWith(from.slice(0, 7)) && calendarMode === "Month" && "bg-muted/30", d === localDate(new Date()) && "bg-primary/5")}><button onClick={() => setDay(d)} aria-label={`Show obligations for ${d}`} className="flex size-7 items-center justify-center rounded-full text-xs font-medium hover:bg-muted focus-visible:outline-2">{Number(d.slice(-2))}</button>{obligations.slice(0, calendarMode === "Day" ? 50 : 2).map(o => <button key={o.id} onClick={() => setSelected(o.id)} className={cn("block w-full truncate rounded border px-1.5 py-1 text-left text-xs focus-visible:outline-2", stateClass(stateOf(o)))} title={`${o.task_revision.title} · ${o.assignee.name} · ${stateOf(o)}`}><span aria-hidden="true">{o.first_submission_id ? "✓ " : stateOf(o) === "Overdue" ? "! " : "• "}</span>{o.task_revision.title}<span className="sr-only"> · {stateOf(o)}</span></button>)}{obligations.length > 2 && calendarMode !== "Day" && <button className="px-1 text-xs text-primary underline" onClick={() => setDay(d)}>+{obligations.length - 2} more</button>}</div>; })}</div></div></div> : view === "By Employee" ? <div className="space-y-4">{bootstrap?.employees.map(e => <section key={e.id}><h3 className="mb-2 text-sm font-medium">{e.name}</h3><ObligationList rows={filtered.filter(o => o.assignee.id === e.id)} onOpen={setSelected} /></section>)}</div> : <ObligationList rows={filtered} onOpen={setSelected} />}
 {!filtered.length && !loading && <div className="py-8 text-center text-sm text-muted-foreground"><CalendarDays className="mx-auto mb-2 size-7" />No obligations match this view. Try another period or clear filters.</div>}
>>>>>>> origin
 {total > 100 && <div className="flex items-center justify-end gap-3 text-sm"><Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous page</Button><span>Page {page} of {Math.ceil(total / 100)}</span><Button variant="outline" disabled={page * 100 >= total} onClick={() => setPage(p => p + 1)}>Next page</Button></div>}
   </CardContent></Card>}</>}
 </main>
 <Dialog open={!!day} onOpenChange={open => { if (!open) setDay(null); }}><DialogContent className="max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>Due on {day}</DialogTitle><DialogDescription>Individual employee obligations for the selected day.</DialogDescription></DialogHeader><ObligationList rows={filtered.filter(o => localDate(o.due_at) === day)} onOpen={id => { setDay(null); setSelected(id); }} /></DialogContent></Dialog>
 {selected && <DetailPanel id={selected} api={api} workspace={workspace} employees={bootstrap?.employees ?? []} onClose={() => setSelected(null)} onChanged={refresh} onEdit={task => { setSelected(null); setForm(task); }} />}
 {form && bootstrap && <TaskForm task={form === "new" ? null : form} bootstrap={bootstrap} api={api} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />}
<<<<<<< HEAD
=======
  <Sheet open={notificationsOpen} onOpenChange={setNotificationsOpen}><SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>Notifications</SheetTitle><SheetDescription>Your in-app updates.</SheetDescription></SheetHeader><div className="space-y-2 p-4">{notifications.length ? notifications.map(n => <button key={n.id} className={cn("w-full rounded-lg border p-3 text-left text-sm", !n.read_at && "bg-primary/5")} onClick={async () => { try { await api(`notifications/${n.id}/read`, { method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }); setNotifications(v => v.map(x => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)); } catch (e) { setError(String(e)); } }}><span className="font-medium">{n.type.replaceAll("_", " ")}</span><span className="mt-1 block text-xs text-muted-foreground">{dateTime(n.created_at)} · {n.read_at ? "Read" : "Unread"}</span></button>) : <p className="text-sm text-muted-foreground">No notifications yet.</p>}</div></SheetContent></Sheet>
>>>>>>> origin
 </div>;
}

function ObligationList({ rows, onOpen }: { rows: OccurrenceView[]; onOpen: (id: string) => void }) {
<<<<<<< HEAD
 return <div className="divide-y rounded-lg border">{rows.length ? rows.map(o => <button key={o.id} onClick={() => onOpen(o.id)} className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-muted/50 focus-visible:outline-2"><div><p className="text-sm font-medium">{o.task.title}</p><p className="text-xs text-muted-foreground">{o.assignee.name} · {dateTime(o.due_at)}</p></div><Badge variant="outline" className={stateClass(stateOf(o))}>{stateOf(o)}</Badge></button>) : <p className="p-4 text-sm text-muted-foreground">No obligations.</p>}</div>;
}

function ListSkeleton() {
 return <div role="status" aria-live="polite" className="space-y-2">{Array.from({ length: 6 }, (_, index) => <div key={index} className="flex h-14 items-center justify-between rounded-md border bg-muted/40 px-3"><div className="space-y-2"><div className="h-3 w-40 animate-pulse rounded bg-muted-foreground/20" /><div className="h-2.5 w-24 animate-pulse rounded bg-muted-foreground/15" /></div><div className="h-5 w-16 animate-pulse rounded bg-muted-foreground/20" /></div>)}<span className="sr-only">Loading obligations…</span></div>;
=======
 return <div className="divide-y rounded-lg border">{rows.length ? rows.map(o => <button key={o.id} onClick={() => onOpen(o.id)} className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-muted/50 focus-visible:outline-2"><div><p className="text-sm font-medium">{o.task_revision.title}</p><p className="text-xs text-muted-foreground">{o.assignee.name} · {dateTime(o.due_at)}</p></div><Badge variant="outline" className={stateClass(stateOf(o))}>{stateOf(o)}</Badge></button>) : <p className="p-4 text-sm text-muted-foreground">No obligations.</p>}</div>;
>>>>>>> origin
}

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
function DetailPanel({ id, api, workspace, employees, onClose, onChanged, onEdit }: { id: string; api: Api; workspace: Workspace; employees: Employee[]; onClose: () => void; onChanged: () => void; onEdit: (task: Task) => void }) {
 const [detail, setDetail] = useState<Detail | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
 const [comment, setComment] = useState(""); const [tab, setTab] = useState("Summary");
 const [action, setAction] = useState(""); const [actionReason, setActionReason] = useState(""); const [deadline, setDeadline] = useState(""); const [changed, setChanged] = useState(false);
 const [eventFilter, setEventFilter] = useState("All");
 const [noticeOpen, setNoticeOpen] = useState(true);
 const reload = useCallback(async () => { const d = await api<Detail>(`occurrences/${id}`); setDetail(d); setChanged(false); }, [api, id]);
 useEffect(() => { let active = true; api<Detail>(`occurrences/${id}`).then(d => { if (active) setDetail(d); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, [api, id]);
 useEffect(() => { const t = setInterval(async () => { try { const d = await api<Detail>(`occurrences/${id}`); if (detail && (d.row_version !== detail.row_version || d.task.revision_number !== detail.task.revision_number)) setChanged(true); } catch { /* User-triggered refresh surfaces errors without clearing drafts. */ } }, 15000); return () => clearInterval(t); }, [api, id, detail]);
 const mutate = async (path: string, body: unknown, method = "POST") => {
  setBusy(true); setError(""); try { await api(path, { method, headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body) }); await reload(); onChanged(); return true; } catch (e) { setError(e instanceof Error ? e.message : "Command failed."); return false; } finally { setBusy(false); }
 };
 const submission = useSubmission({ detail, api, onBusyChange: setBusy, onError: setError, onSubmitted: async () => { await reload(); onChanged(); setTab("Versions"); } });
 const name = (id: string) => employees.find(e => e.id === id)?.name ?? `Employee ${id}`;
<<<<<<< HEAD
 return <Sheet open onOpenChange={open => { if (!open && !busy) onClose(); }}><SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl"><SheetHeader className="border-b p-5"><SheetTitle>{detail?.task.title ?? "Task details"}</SheetTitle><SheetDescription>Individual obligation · {detail ? dateTime(detail.due_at) : "Loading…"} · Asia/Manila</SheetDescription></SheetHeader><div className="space-y-5 p-5">
=======
 return <Sheet open onOpenChange={open => { if (!open && !busy) onClose(); }}><SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl"><SheetHeader className="border-b p-5"><SheetTitle>{detail?.task_revision.title ?? "Task details"}</SheetTitle><SheetDescription>Individual obligation · {detail ? dateTime(detail.due_at) : "Loading…"} · Asia/Manila</SheetDescription></SheetHeader><div className="space-y-5 p-5">
>>>>>>> origin
 {error && <p role="alert" className="rounded border border-destructive/40 p-3 text-sm text-destructive">{error}<Button size="sm" variant="ghost" onClick={() => reload().catch(e => setError(String(e)))}>Refresh details</Button></p>}
 {changed && <div role="alert" className="rounded-lg border border-amber-500 p-3 text-sm">This task changed while open. Refresh before submitting; your draft remains here.<Button size="sm" variant="outline" onClick={() => reload().catch(e => setError(String(e)))}>Refresh Details</Button></div>}
 {!detail ? <p role="status">Loading details…</p> : <>
 <div className="flex flex-wrap gap-2"><Badge className={stateClass(stateOf(detail))} variant="outline">{stateOf(detail)}</Badge><Badge variant="secondary">{detail.task_revision.priority}</Badge><Badge variant="outline">{frequencyLabels[detail.task_revision.schedule.frequency]}</Badge></div>
 {detail.unacknowledged.length > 0 && workspace === "my-tasks" && <section aria-label="Unacknowledged task changes" className="space-y-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-4"><h3 className="font-medium">Task updated · acknowledgment required</h3><p className="text-xs text-muted-foreground">A read receipt, not agreement. Dismissing this panel does not acknowledge changes.</p>{detail.unacknowledged.map(e => <div key={e.id} className="space-y-2 border-t pt-2 text-sm"><p>{e.event_type.replaceAll("_", " ")} · {name(e.actor_id)} · {dateTime(e.created_at)}</p><p>Reason: {e.reason}</p><pre className="max-h-36 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ old: e.old_values, new: e.new_values }, null, 2)}</pre><Button size="sm" disabled={busy} onClick={() => mutate(`occurrences/${id}/acknowledge`, { event_id: e.id })}>Acknowledge Update</Button></div>)}</section>}
 <div className="flex flex-wrap gap-1" role="tablist" aria-label="Task detail sections">{["Summary", "Versions", "Comments", "Activity"].map(t => <Button key={t} role="tab" aria-selected={tab === t} size="sm" variant={tab === t ? "secondary" : "ghost"} onClick={() => setTab(t)}>{t}</Button>)}</div>
<<<<<<< HEAD
 {tab === "Summary" && <><dl className="grid grid-cols-2 gap-3 text-sm">{[["Assignee", detail.assignee.name], ["Created by", name(detail.task_revision.created_by)], ["Report to", name(detail.task_revision.report_to_user_id)], ["Original due", dateTime(detail.original_due_at)], ["Effective due", dateTime(detail.due_at)], ["Available from", dateTime(detail.available_at)]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1">{value}</dd></div>)}</dl>{detail.events.filter(event => /^(TASK_(DETAILS_UPDATED|SCHEDULE_CHANGED|PAUSED|RESUMED|CANCELLED|ARCHIVED|DEADLINE_CHANGED)|OCCURRENCE_(CANCELLED|DEADLINE_CHANGED))$/.test(event.event_type)).toReversed().slice(0, 1).map(event => <section key={event.id} className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"><h3 className="text-sm font-medium">Latest change · {event.event_type.replaceAll("_", " ").toLowerCase()}</h3><p className="text-sm">Reason: {event.reason || "No reason provided"}</p><details><summary className="cursor-pointer text-xs text-primary">View change details</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{JSON.stringify({ old: event.old_values, new: event.new_values }, null, 2)}</pre></details></section>)}<section><h3 className="mb-2 text-sm font-medium">Instructions · revision {detail.task_revision.revision_number}</h3><p className="whitespace-pre-wrap text-sm">{detail.task_revision.description}</p></section>{detail.task_revision.reference_file_ids.length > 0 && <section><h3 className="text-sm font-medium">Reference attachments</h3>{detail.task_revision.reference_file_ids.map(id => <a key={id} href={`${BASE}/files/${id}/download?workspace=${workspace}`} className="block text-sm text-primary underline">{detail.files.find(f => f.id === id)?.name ?? "Reference file"}</a>)}</section>}
=======
 {tab === "Summary" && <><dl className="grid grid-cols-2 gap-3 text-sm">{[["Assignee", detail.assignee.name], ["Created by", name(detail.task_revision.created_by)], ["Report to", name(detail.task_revision.report_to_user_id)], ["Original due", dateTime(detail.original_due_at)], ["Effective due", dateTime(detail.due_at)], ["Available from", dateTime(detail.available_at)]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1">{value}</dd></div>)}</dl><section><h3 className="mb-2 text-sm font-medium">Instructions · revision {detail.task_revision.revision_number}</h3><p className="whitespace-pre-wrap text-sm">{detail.task_revision.description}</p></section>{detail.task_revision.reference_file_ids.length > 0 && <section><h3 className="text-sm font-medium">Reference attachments</h3>{detail.task_revision.reference_file_ids.map(id => <a key={id} href={`${BASE}/files/${id}/download?workspace=${workspace}`} className="block text-sm text-primary underline">{detail.files.find(f => f.id === id)?.name ?? "Reference file"}</a>)}</section>}
>>>>>>> origin
  {detail.can_submit && <SubmissionBin detail={detail} controller={submission} busy={busy} changed={changed} />}
  {workspace === "my-tasks" && !detail.can_submit && !detail.first_submission_id && detail.status !== "CANCELLED" && <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">The submission bin becomes available when this obligation reaches its “Available from” time.</p>}
 {detail.can_edit && <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => onEdit(detail.task)}>Edit Task</Button>{["deadline", "cancel-occurrence", detail.task.lifecycle_status === "PAUSED" ? "resume" : "pause", "cancel-task"].map(a => <Button key={a} variant="outline" onClick={() => { setAction(a); setActionReason(""); }}>{a.replaceAll("-", " ")}</Button>)}</div>}</>}
 {tab === "Versions" && <div className="space-y-4">{detail.submissions.length ? detail.submissions.toReversed().map(s => <section key={s.id} className="space-y-2 rounded-lg border p-4"><div className="flex justify-between"><h3 className="text-sm font-medium">Version {s.version_number}</h3><Badge variant="outline">{s.is_late ? s.version_number === 1 ? "Submitted late" : "Late revision" : "On time"}</Badge></div><p className="text-xs text-muted-foreground">{dateTime(s.submitted_at)} · {name(s.submitted_by)}<br />Evaluated deadline: {dateTime(s.evaluated_due_at)}</p>{s.remark && <p className="text-sm">{s.remark}</p>}{s.revision_reason && <p className="text-sm">Reason: {s.revision_reason}</p>}{s.file_ids.map(id => <a key={id} href={`${BASE}/files/${id}/download?workspace=${workspace}`} className="block text-sm text-primary underline">{detail.files.find(f => f.id === id)?.name ?? "Download file"}</a>)}</section>) : <p className="text-sm text-muted-foreground">No deliverable submitted yet.</p>}</div>}
 {tab === "Comments" && <div className="space-y-3"><p className="text-xs text-muted-foreground">Discussion only — not an approval/rejection workflow.</p>{detail.comments.map(c => <div key={c.id} className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{name(c.author_id)} · {dateTime(c.created_at)}</p><p className="mt-1 whitespace-pre-wrap text-sm">{c.text}</p></div>)}{detail.can_comment && <><label className="block text-sm">Comment<Textarea value={comment} onChange={e => setComment(e.target.value)} /></label><Button disabled={busy || !comment.trim()} onClick={async () => { if (await mutate(`occurrences/${id}/comments`, { text: comment })) setComment(""); }}>Post Comment</Button></>}</div>}
 {tab === "Activity" && <div className="space-y-3"><div className="flex flex-wrap gap-1">{["All", "Changes", "Submissions", "Comments"].map(f => <Button key={f} variant={eventFilter === f ? "secondary" : "ghost"} size="sm" onClick={() => setEventFilter(f)}>{f}</Button>)}</div>{detail.events.filter(e => eventFilter === "All" || eventFilter === "Changes" && e.material || eventFilter === "Submissions" && /SUBMISSION_(CREATED|REVISED)/.test(e.event_type) || eventFilter === "Comments" && e.event_type === "SUBMISSION_COMMENTED").toReversed().map(e => <article key={e.id} className="border-l-2 pl-4"><h3 className="text-sm font-medium">{e.event_type.replaceAll("_", " ")}</h3><p className="text-xs text-muted-foreground">{name(e.actor_id)} · {dateTime(e.created_at)}</p><p className="mt-1 text-sm">{e.reason}</p><details className="mt-2 text-xs"><summary className="cursor-pointer text-primary">Old → new values</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{JSON.stringify({ old: e.old_values, new: e.new_values }, null, 2)}</pre></details></article>)}</div>}
 </>}
 </div></SheetContent>
 <Dialog open={noticeOpen && workspace === "my-tasks" && !!detail?.unacknowledged.length} onOpenChange={setNoticeOpen}><DialogContent className="max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>Task Updated</DialogTitle><DialogDescription>An assignor changed this task. Acknowledging is a read receipt, not agreement. Dismissal leaves the update unread.</DialogDescription></DialogHeader>{detail?.unacknowledged.map(event => <section key={event.id} className="space-y-2 border-t pt-3"><p className="text-sm font-medium">{event.event_type.replaceAll("_", " ")}</p><p className="text-xs text-muted-foreground">{name(event.actor_id)} · {dateTime(event.created_at)}</p><p className="text-sm">Reason: {event.reason}</p><pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{JSON.stringify({ old: event.old_values, new: event.new_values }, null, 2)}</pre><Button disabled={busy} onClick={() => mutate(`occurrences/${id}/acknowledge`, { event_id: event.id })}>Acknowledge Update</Button></section>)}</DialogContent></Dialog>
<<<<<<< HEAD
 <Dialog open={!!action} onOpenChange={open => { if (!open) setAction(""); }}><DialogContent><DialogHeader><DialogTitle>Confirm {action.replaceAll("-", " ")}</DialogTitle><DialogDescription>Changes are audited and notified. Completed submissions remain historical records.</DialogDescription></DialogHeader>{action === "deadline" && <fieldset className="space-y-2"><legend className="text-sm font-medium">New effective deadline · Manila time</legend><div className="grid grid-cols-2 gap-3"><label className="text-sm">Date<Input type="date" required value={deadline.slice(0, 10)} onChange={e => setDeadline(`${e.target.value}T${deadline.slice(11, 16) || "17:00"}`)} /></label><label className="text-sm">Time<Input type="time" required value={deadline.slice(11, 16)} onChange={e => setDeadline(`${deadline.slice(0, 10)}T${e.target.value}`)} /></label></div><p className="text-xs text-muted-foreground">Choose the date and local time when this obligation is due.</p></fieldset>}<label className="text-sm">Reason (required)<Textarea value={actionReason} onChange={e => setActionReason(e.target.value)} /></label><Button disabled={busy || !actionReason.trim() || action === "deadline" && !deadline} onClick={async () => { if (!detail) return; const occurrenceAction = action === "deadline" || action === "cancel-occurrence"; const path = occurrenceAction ? `occurrences/${id}/${action === "deadline" ? "deadline" : "cancel"}` : `tasks/${detail.task.id}/${action === "cancel-task" ? "cancel" : action}`; const ok = await mutate(path, { reason: actionReason, expected_revision: occurrenceAction ? detail.row_version : detail.task.revision_number, ...(action === "deadline" ? { due_at: new Date(deadline + ":00+08:00").toISOString() } : {}) }, action === "deadline" ? "PATCH" : "POST"); if (ok) setAction(""); }}>Confirm change</Button></DialogContent></Dialog>
=======
 <Dialog open={!!action} onOpenChange={open => { if (!open) setAction(""); }}><DialogContent><DialogHeader><DialogTitle>Confirm {action.replaceAll("-", " ")}</DialogTitle><DialogDescription>Changes are audited and notified. Completed submissions remain historical records.</DialogDescription></DialogHeader>{action === "deadline" && <label className="text-sm">New effective deadline (Manila)<Input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} /></label>}<label className="text-sm">Reason (required)<Textarea value={actionReason} onChange={e => setActionReason(e.target.value)} /></label><Button disabled={busy || !actionReason.trim() || action === "deadline" && !deadline} onClick={async () => { if (!detail) return; const occurrenceAction = action === "deadline" || action === "cancel-occurrence"; const path = occurrenceAction ? `occurrences/${id}/${action === "deadline" ? "deadline" : "cancel"}` : `tasks/${detail.task.id}/${action === "cancel-task" ? "cancel" : action}`; const ok = await mutate(path, { reason: actionReason, expected_revision: occurrenceAction ? detail.row_version : detail.task.revision_number, ...(action === "deadline" ? { due_at: new Date(deadline + ":00+08:00").toISOString() } : {}) }, action === "deadline" ? "PATCH" : "POST"); if (ok) setAction(""); }}>Confirm change</Button></DialogContent></Dialog>
>>>>>>> origin
 </Sheet>;
}

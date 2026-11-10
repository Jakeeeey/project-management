"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DashboardProps } from "../shared/workspace-types";
import { selectClass } from "../shared/presentation";

export function ExecutiveDashboard({ data: { employees }, selectedEmployee, periodLabel, onSelectEmployee, onClearEmployee }: DashboardProps) {
 const [search, setSearch] = useState(""); const [department, setDepartment] = useState("");
 const [progress, setProgress] = useState("ALL");
 const departments = useMemo(() => [...new Map(employees.filter(e => (e.due > 0 || e.backlog > 0) && e.department_id).map(e => [e.department_id, e.department])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [employees]);
 const activeEmployees = employees.filter(employee => employee.due > 0 || employee.backlog > 0);
 const selected = employees.find(employee => employee.id === selectedEmployee);
 const visible = activeEmployees.filter(employee =>
  (!search || `${employee.name} ${employee.department}`.toLowerCase().includes(search.trim().toLowerCase())) &&
  (!department || employee.department_id === department) &&
  (progress === "ALL" || progress === "OVERDUE" && employee.overdue + employee.backlog > 0 || progress === "COMPLETE" && employee.due > 0 && employee.submitted >= employee.due || progress === "IN_PROGRESS" && employee.submitted > 0 && employee.submitted < employee.due),
 );
 if (selectedEmployee) return <section className="space-y-3" aria-label="Selected employee calendar">
  <div className="flex flex-wrap items-center justify-between gap-3"><div><Button variant="ghost" size="sm" onClick={onClearEmployee}><ArrowLeft className="mr-2 size-4" />All employees</Button><h2 className="mt-1 text-lg font-semibold">{selected?.name ?? "Employee tasks"}</h2><p className="text-sm text-muted-foreground">{selected?.department} · {periodLabel}</p></div>
   {selected && <div className="min-w-48 rounded-lg border p-3"><div className="flex justify-between text-xs"><span>Delivery progress</span><span>{selected.submitted}/{selected.due}</span></div><div role="progressbar" aria-label={`${selected.name} delivery progress`} aria-valuenow={selected.due ? Math.round(selected.submitted / selected.due * 100) : 0} aria-valuemin={0} aria-valuemax={100} className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${selected.due ? Math.min(100, selected.submitted / selected.due * 100) : 0}%` }} /></div><p className="mt-1 text-xs text-muted-foreground">{selected.overdue + selected.backlog} overdue</p></div>}
  </div>
 </section>;
 return <Card><CardHeader><CardTitle className="text-base">Employees with tasks</CardTitle><p className="text-sm text-muted-foreground">Choose an employee to view their task calendar and progress for {periodLabel}.</p></CardHeader><CardContent className="space-y-4">
  <div className="grid gap-2 md:grid-cols-3"><div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Search employees" placeholder="Search employees…" className="pl-9" value={search} onChange={event => setSearch(event.target.value)} /></div><select aria-label="Filter by department" className={selectClass} value={department} onChange={event => setDepartment(event.target.value)}><option value="">All departments</option>{departments.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><select aria-label="Filter by progress" className={selectClass} value={progress} onChange={event => setProgress(event.target.value)}><option value="ALL">All progress</option><option value="OVERDUE">Has overdue tasks</option><option value="IN_PROGRESS">In progress</option><option value="COMPLETE">All due tasks submitted</option></select></div>
  <div className="divide-y rounded-lg border">{visible.length ? visible.map(employee => <button key={employee.id} onClick={() => onSelectEmployee(employee.id)} className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-muted/50 focus-visible:outline-2"><span><span className="block font-medium">{employee.name}</span><span className="text-xs text-muted-foreground">{employee.department} · {employee.overdue + employee.backlog} overdue</span></span><span className="min-w-40"><span className="flex justify-between text-xs"><span>{employee.submitted} of {employee.due} submitted</span><span>{employee.due ? Math.round(employee.submitted / employee.due * 100) : 0}%</span></span><span className="mt-1 block h-2 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${employee.due ? Math.min(100, employee.submitted / employee.due * 100) : 0}%` }} /></span></span></button>) : <p className="p-6 text-center text-sm text-muted-foreground">No employees with tasks match these filters.</p>}</div>
 </CardContent></Card>;
}

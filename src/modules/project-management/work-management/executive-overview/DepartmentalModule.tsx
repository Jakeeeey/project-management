"use client";

import { WorkWorkspace } from "./WorkWorkspace";
import { ExecutiveDashboard } from "./ExecutiveDashboard";
import type { DashboardData, HeaderAccount, WorkspaceDefinition } from "./workspace-types";

const definition: WorkspaceDefinition = {
 workspace: "departmental",
 title: "Departmental Overview",
 description: "Department-only visibility into employee workload and delivery progress.",
 views: ["Calendar"],
 progressLabel: "Department delivery progress",
 Dashboard: ExecutiveDashboard,
 async loadDashboard(api, query) {
  const analytics = await api<{ employees: DashboardData["employees"] }>(`analytics/employees?${query}`);
  return { employees: analytics.employees, trends: [] };
 },
};

export function DepartmentalModule({ account }: { account: HeaderAccount }) {
 return <WorkWorkspace definition={definition} account={account} />;
}

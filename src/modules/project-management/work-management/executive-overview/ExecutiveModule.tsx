"use client";

import { WorkWorkspace } from "../shared/WorkWorkspace";
import { ExecutiveDashboard } from "./ExecutiveDashboard";
import type { DashboardData, HeaderAccount, WorkspaceDefinition } from "../shared/workspace-types";

const definition: WorkspaceDefinition = {
 workspace: "executive",
 title: "Executive Overview",
 description: "Company-wide visibility. Read-only by design.",
 views: ["Calendar"],
 progressLabel: "Company delivery progress",
 Dashboard: ExecutiveDashboard,
 async loadDashboard(api, query) {
   const analytics = await api<{ employees: DashboardData["employees"] }>(`analytics/employees?${query}`);
   return { employees: analytics.employees, trends: [] };
 },
};

export function ExecutiveModule({ account }: { account: HeaderAccount }) {
 return <WorkWorkspace definition={definition} account={account} />;
}

import type { ComponentType } from "react";
import type { Bootstrap, Employee, OccurrenceView, Summary, Workspace } from "./types";

export type WorkApi = <T>(path: string, init?: RequestInit) => Promise<T>;
export interface HeaderAccount { name: string; email: string; avatar: string }
export interface TrendPoint { date: string; due: number; submitted: number; on_time: number }
export interface DashboardData { employees: (Employee & Summary)[]; trends: TrendPoint[] }
export interface WorkspaceActionsProps { bootstrap: Bootstrap | null; onCreate: () => void }
export interface DashboardProps {
 data: DashboardData; selectedEmployee: string;
 periodLabel: string; onSelectEmployee: (id: string) => void; onClearEmployee: () => void;
}
export interface OverviewProps { bootstrap: Bootstrap | null; rows: OccurrenceView[]; onCreate: () => void; onOpen: (id: string) => void }
export interface WorkspaceDefinition {
 workspace: Workspace;
 title: string;
 description: string;
 views: readonly string[];
 initialView?: string;
<<<<<<< HEAD
  progressLabel?: string;
  globalAssignment?: boolean;
=======
 progressLabel?: string;
>>>>>>> origin
 Overview?: ComponentType<OverviewProps>;
 Actions?: ComponentType<WorkspaceActionsProps>;
 Dashboard?: ComponentType<DashboardProps>;
 loadDashboard?: (api: WorkApi, query: URLSearchParams) => Promise<DashboardData>;
}

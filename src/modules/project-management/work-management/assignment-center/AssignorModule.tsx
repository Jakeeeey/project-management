"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkWorkspace } from "./WorkWorkspace";
import type { HeaderAccount, WorkspaceActionsProps, WorkspaceDefinition } from "./workspace-types";
import { AssignmentOverview } from "./AssignmentOverview";
import { assignmentAvailability } from "./availability";

function AssignorActions({ bootstrap, onCreate }: WorkspaceActionsProps) {
 const canOpen = !!bootstrap && (bootstrap.capabilities.assign || bootstrap.workspace_access?.includes("assignor") === true || bootstrap.actor.read_workspaces?.includes("assignor") === true);
 const availability = bootstrap ? assignmentAvailability(bootstrap) : null;
  return <div className="space-y-1 text-right"><Button disabled={!canOpen} onClick={onCreate}><Plus className="mr-2 size-4" />Create &amp; Assign Task</Button>{availability && !availability.canSave && canOpen && <p className="text-xs text-muted-foreground">Read-only · saving unavailable</p>}</div>;
}

const definition: WorkspaceDefinition = {
 workspace: "assignor",
  title: "Departmental Assignment Center",
  description: "Coordinate and track individual obligations within your department.",
 views: ["Calendar", "All Tasks", "By Employee"],
 initialView: "All Tasks",
 progressLabel: "Team delivery progress",
 Overview: AssignmentOverview,
 Actions: AssignorActions,
};

export function AssignorModule({ account, global = false }: { account: HeaderAccount; global?: boolean }) {
  const workspaceDefinition = global ? { ...definition, title: "Global Assignment Center", description: "Assign and track work across every department in the company.", globalAssignment: true } : definition;
  return <WorkWorkspace definition={workspaceDefinition} account={account} />;
}

"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { WorkWorkspace } from "./WorkWorkspace";
import type { HeaderAccount, WorkspaceActionsProps, WorkspaceDefinition } from "./workspace-types";
import { AssignmentOverview } from "./AssignmentOverview";
import { assignmentAvailability } from "./availability";

function AssignorActions({ bootstrap, onCreate }: WorkspaceActionsProps) {
 const canOpen = !!bootstrap && (bootstrap.capabilities.assign || bootstrap.workspace_access?.includes("assignor") === true || bootstrap.actor.read_workspaces?.includes("assignor") === true);
 const availability = bootstrap ? assignmentAvailability(bootstrap) : null;
  return <div className="flex flex-wrap items-center justify-end gap-2"><Button disabled={!canOpen} onClick={onCreate}><Plus className="mr-2 size-4" />Create &amp; Assign Task</Button>{bootstrap?.workspace_access?.includes("departmental") && <Button asChild variant="outline"><Link href="/project-management/work-management/departmental-overview">Departmental Overview</Link></Button>}{availability && !availability.canSave && canOpen && <p className="w-full text-right text-xs text-muted-foreground">Read-only · saving unavailable</p>}</div>;
}

const definition: WorkspaceDefinition = {
 workspace: "assignor",
 title: "Assignment Center",
 description: "Coordinate work. Track individual deliverables. Keep every change accountable.",
 views: ["Calendar", "All Tasks", "By Employee"],
 initialView: "All Tasks",
 progressLabel: "Team delivery progress",
 Overview: AssignmentOverview,
 Actions: AssignorActions,
};

export function AssignorModule({ account }: { account: HeaderAccount }) {
 return <WorkWorkspace definition={definition} account={account} />;
}

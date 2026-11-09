"use client";

import { WorkWorkspace } from "../shared/WorkWorkspace";
import type { HeaderAccount, WorkspaceDefinition } from "../shared/workspace-types";

const definition: WorkspaceDefinition = {
 workspace: "my-tasks",
 title: "My Tasks",
 description: "Your deadlines, deliverables, and progress — one obligation at a time.",
 views: ["Calendar", "Backlog", "For review"],
 progressLabel: "My delivery progress",
};

export function AssigneeModule({ account }: { account: HeaderAccount }) {
 return <WorkWorkspace definition={definition} account={account} />;
}

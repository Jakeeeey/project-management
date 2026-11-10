import { notFound, redirect } from "next/navigation";
import { normalizeWorkspace, workspacePath } from "@/modules/project-management/work-management/assignment-center/workspace-access";

export const dynamic = "force-dynamic";

export default async function LegacyWorkspacePage({ params }: { params: Promise<{ workspace: string }> }) {
 const { workspace } = await params;
 const normalized = normalizeWorkspace(workspace);
 if (!normalized) notFound();
 redirect(workspacePath(normalized));
}

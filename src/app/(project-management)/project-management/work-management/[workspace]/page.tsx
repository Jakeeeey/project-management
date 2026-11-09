import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { COOKIE_NAME, decodeJwtPayload } from "@/lib/auth-utils";
import { AssignorModule } from "@/modules/project-management/work-management/assignment-center/AssignorModule";
import { AssigneeModule } from "@/modules/project-management/work-management/my-tasks/AssigneeModule";
import { ExecutiveModule } from "@/modules/project-management/work-management/executive-overview/ExecutiveModule";
import { normalizeWorkspace } from "@/modules/project-management/work-management/workspace-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Work Management | VOS" };

function headerAccount(token: string | undefined) {
 const payload = token ? decodeJwtPayload(token) : null;
 const pick = (keys: string[]) => {
  for (const key of keys) {
   const value = payload?.[key];
   if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
 };
 const first = pick(["Firstname", "FirstName", "firstName", "firstname", "first_name"]);
 const last = pick(["LastName", "Lastname", "lastName", "lastname", "last_name"]);
 const email = pick(["email", "Email"]);
 return { name: [first, last].filter(Boolean).join(" ") || email || "User", email, avatar: "/avatars/shadcn.jpg" };
}

export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
 const { workspace } = await params;
 const token = (await cookies()).get(COOKIE_NAME)?.value;
 const account = headerAccount(token);
  switch (normalizeWorkspace(workspace)) {
    case "assignor": return <AssignorModule account={account} />;
    case "my-tasks": return <AssigneeModule account={account} />;
   case "executive": return <ExecutiveModule account={account} />;
  default: notFound();
 }
}

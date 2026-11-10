import { cookies } from "next/headers";
import { COOKIE_NAME, decodeJwtPayload } from "@/lib/auth-utils";
import { AssigneeModule } from "@/modules/project-management/work-management/my-tasks/AssigneeModule";

export const dynamic = "force-dynamic";
export const metadata = { title: "My Tasks | Work Management" };

function accountFromToken(token: string | undefined) {
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

export default async function Page() {
 const token = (await cookies()).get(COOKIE_NAME)?.value;
 const account = accountFromToken(token);
 return <AssigneeModule account={account} />;
}

import { cookies } from "next/headers";
import { COOKIE_NAME, decodeJwtPayload } from "@/lib/auth-utils";
import { AssignorModule } from "@/modules/project-management/work-management/assignment-center/AssignorModule";

export const dynamic = "force-dynamic";
export const metadata = { title: "Global Assignment Center | Work Management" };

export default async function GlobalAssignmentCenterPage() {
 const token = (await cookies()).get(COOKIE_NAME)?.value;
 const payload = token ? decodeJwtPayload(token) : null;
 const pick = (keys: string[]) => keys.map(key => payload?.[key]).find(value => typeof value === "string" && value.trim())?.toString().trim() ?? "";
 const first = pick(["Firstname", "FirstName", "firstName", "firstname", "first_name"]);
 const last = pick(["LastName", "Lastname", "lastName", "lastname", "last_name"]);
 const email = pick(["email", "Email"]);
 return <AssignorModule global account={{ name: [first, last].filter(Boolean).join(" ") || email || "User", email, avatar: "/avatars/shadcn.jpg" }} />;
}

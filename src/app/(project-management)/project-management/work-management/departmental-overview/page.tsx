import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, decodeJwtPayload } from "@/lib/auth-utils";
import { DepartmentalModule } from "@/modules/project-management/work-management/executive-overview/DepartmentalModule";

export const dynamic = "force-dynamic";
export const metadata = { title: "Departmental Overview | Work Management" };

export default async function DepartmentalOverviewPage() {
 const token = (await cookies()).get(COOKIE_NAME)?.value;
 if (!token) redirect("/login");
 const payload = decodeJwtPayload(token);
 const account = {
  name: String(payload?.name ?? payload?.full_name ?? payload?.username ?? "Employee"),
  email: String(payload?.email ?? ""),
  avatar: String(payload?.avatar ?? ""),
 };
 return <DepartmentalModule account={account} />;
}

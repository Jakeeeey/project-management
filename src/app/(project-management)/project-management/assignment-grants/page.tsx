import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { NavUser } from "@/components/shared/app-sidebar/nav-user";

import { cookies } from "next/headers";
import type { Metadata } from "next";

import { COOKIE_NAME, decodeJwtPayload, type JwtPayload } from "@/lib/auth-utils";
import { AssignmentGrantsPage } from "@/modules/project-management/assignment-grants/components/AssignmentGrantsPage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Assignment Grants | Project Management",
    description: "Grant department members the right to assign tasks.",
};

/**
 * Picks the first usable string claim from the decoded token.
 *
 * The nested cookies module needs no local `COOKIE_NAME` or `decodeJwtPayload` — both come from
 * `@/lib/auth-utils`, the repo's single decoder — so this file only adapts the claim casing the
 * Spring-minted token happens to use into a header label.
 */
function pickString(payload: JwtPayload | null, keys: readonly string[]): string {
    for (const key of keys) {
        const value = payload ? payload[key] : undefined;
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

function buildHeaderUserFromToken(token: string | null | undefined) {
    const payload = token ? decodeJwtPayload(token) : null;

    const first = pickString(payload, ["Firstname", "FirstName", "firstName", "firstname", "first_name"]);
    const last = pickString(payload, ["LastName", "Lastname", "lastName", "lastname", "last_name"]);
    const email = pickString(payload, ["email", "Email"]);

    const name = [first, last].filter(Boolean).join(" ") || email || "User";

    return {
        name,
        email: email || "",
        avatar: "/avatars/shadcn.jpg",
    };
}

/**
 * The Assignment Grants route page.
 *
 * A thin server shell matching the sibling pm pages: the pm layout is a fixed-height frame where
 * only `<main>` scrolls, so this renders the app header (SidebarTrigger, Separator, Breadcrumb,
 * NavUser) plus a scrolling `<main>` and delegates everything else to the client orchestrator.
 *
 * The actor's department and capabilities are deliberately NOT resolved here and never passed down:
 * the grants route owns both, reading them from the session cookie on every request, which is what
 * keeps the capability flags server-authoritative.
 */
export default async function Page() {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value ?? null;

    const headerUser = buildHeaderUserFromToken(token);

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <header className="relative z-10 flex h-14 shrink-0 items-center justify-between border-b shadow-sm bg-background sm:h-16 overflow-hidden">
                <div className="flex h-full min-w-0 items-center gap-2 px-3 sm:px-4 overflow-hidden">
                    <SidebarTrigger className="-ml-1 shrink-0" />

                    <Separator
                        orientation="vertical"
                        className="hidden sm:block mr-2 data-[orientation=vertical]:h-4 shrink-0"
                    />

                    <div className="min-w-0 overflow-hidden">
                        <Breadcrumb>
                            <BreadcrumbList className="min-w-0 overflow-hidden">
                                <BreadcrumbItem className="hidden md:block shrink-0">
                                    <BreadcrumbLink href="#">Project Management</BreadcrumbLink>
                                </BreadcrumbItem>
                                <BreadcrumbSeparator className="hidden md:block shrink-0" />
                                <BreadcrumbItem className="min-w-0 overflow-hidden">
                                    <BreadcrumbPage className="truncate max-w-[56vw] sm:max-w-[60vw] md:max-w-none">
                                        Assignment Grants
                                    </BreadcrumbPage>
                                </BreadcrumbItem>
                            </BreadcrumbList>
                        </Breadcrumb>
                    </div>
                </div>

                <div className="flex h-full items-center px-2 sm:px-4 shrink-0 max-w-[48vw] sm:max-w-none overflow-hidden">
                    <NavUser user={headerUser} />
                </div>
            </header>

            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-2 sm:p-4">
                <AssignmentGrantsPage />
            </main>
        </div>
    );
}

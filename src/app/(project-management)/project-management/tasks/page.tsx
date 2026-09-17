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
import { TasksModule } from "@/modules/project-management/tasks/TasksModule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Tasks | Project Management",
    description: "Your department's tasks, sub-tasks, assignees and due dates.",
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
 * Reads the signed-in user's id from the decoded token, in the same precedence the server's actor
 * resolver uses (`id` -> `user_id` -> `sub`).
 *
 * Only the identity is read here. The department is deliberately NOT derived from the token — there
 * is no department claim — and capabilities are never computed on the client: both come from the
 * task routes on every request, which is what keeps scoping and permissions server-authoritative.
 */
function readUserId(payload: JwtPayload | null): number | null {
    if (payload === null) return null;

    const candidates: readonly unknown[] = [payload.id, payload.user_id, payload.sub];
    for (const candidate of candidates) {
        const userId = Number(candidate);
        if (Number.isInteger(userId) && userId > 0) return userId;
    }
    return null;
}

/**
 * The Tasks route page.
 *
 * A thin server shell matching the sibling pm pages: the pm layout is a fixed-height frame where
 * only `<main>` scrolls, so this renders the app header (SidebarTrigger, Separator, Breadcrumb,
 * NavUser) plus a scrolling `<main>` and delegates everything else to the client orchestrator.
 *
 * The only prop passed down is the actor's `userId` (from the session cookie). The department and
 * the capability flags are resolved server-side inside the task routes on every request and are
 * never re-derived here — the sibling pages' local `COOKIE_NAME`/`decodeJwtPayload` are deliberately
 * NOT copied, and the breadcrumb intentionally reads `Project Management` rather than their
 * hardcoded root label.
 */
export default async function Page() {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value ?? null;

    const headerUser = buildHeaderUserFromToken(token);
    const userId = readUserId(token ? decodeJwtPayload(token) : null);

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
                                        Tasks
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
                <TasksModule userId={userId} />
            </main>
        </div>
    );
}

/**
 * Resolves the signed-in actor on every request.
 *
 * The department is NEVER taken from the token: `JwtPayload` (src/lib/auth-utils.ts) declares no
 * department claim, and even if one existed it would be a hint — the `user` table is authoritative.
 * A user without a department resolves to `departmentId: null` and the route answers 403; it never
 * falls back to an unscoped query.
 *
 * Identity and the department lookup are two separate answers, so the return value distinguishes
 * them: `null` means "no session" (401), while a resolved actor with a null department means
 * "session, but nothing to scope to" (403).
 */

import { cookies } from "next/headers";
import { COOKIE_NAME, decodeJwtPayload, type JwtPayload } from "@/lib/auth-utils";
import { readItem, readItems } from "./directus-client";

/** The signed-in user, as the server resolved them. */
export interface Actor {
    readonly userId: number;
    /** `null` = the authoritative lookup resolved no department; routes must answer 403. */
    readonly departmentId: number | null;
    readonly isDepartmentHead: boolean;
}

/** An actor whose department is known — the only shape the scoped loaders accept. */
export interface ScopedActor extends Actor {
    readonly departmentId: number;
}

/** Type guard that turns a resolved `Actor` into a `ScopedActor` once the route has checked 403. */
export function isScopedActor(actor: Actor): actor is ScopedActor {
    return actor.departmentId !== null;
}

/** The `user` fields the actor resolver reads. */
interface UserDepartmentRow {
    readonly user_department: number | string | null;
    readonly is_deleted: number | string | boolean | null;
}

/**
 * Reads the user id out of the decoded token, in the precedence the rest of the app uses
 * (`id` -> `user_id` -> `sub`). Each candidate is normalised, so a claim carrying an email or an
 * empty string is skipped rather than producing a bogus lookup.
 */
function readUserId(payload: JwtPayload): number | null {
    const candidates: readonly unknown[] = [payload.id, payload.user_id, payload.sub];
    for (const candidate of candidates) {
        const userId = Number(candidate);
        if (Number.isInteger(userId) && userId > 0) return userId;
    }
    return null;
}

/** TINYINT-shaped flags arrive as number, string or boolean depending on the payload shape. */
function isSoftDeleted(value: unknown): boolean {
    if (value === true) return true;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
    return false;
}

/** Normalises `user_department`; anything that cannot be a department key resolves to `null`. */
function toDepartmentId(value: number | string | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const departmentId = Number(value);
    return Number.isInteger(departmentId) && departmentId > 0 ? departmentId : null;
}

/**
 * Resolves `{ userId, departmentId, isDepartmentHead }` for the request's cookie.
 *
 * @returns `null` when there is no session — missing/undecodable cookie, unusable user id, or a
 *          soft-deleted user row. The route answers 401. Otherwise the actor, whose
 *          `departmentId` may be `null` (route answers 403, never an unscoped query).
 */
export async function resolveActor(): Promise<Actor | null> {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) return null;

    const payload = decodeJwtPayload(token);
    if (payload === null) return null;

    const userId = readUserId(payload);
    if (userId === null) return null;

    const user = await readItem<UserDepartmentRow>("user", userId, {
        fields: ["user_department", "is_deleted"],
    });
    if (user === null || isSoftDeleted(user.is_deleted)) return null;

    const departmentId = toDepartmentId(user.user_department);
    if (departmentId === null) {
        return { userId, departmentId: null, isDepartmentHead: false };
    }

    // Headship is a `department` row whose `department_head_id` is this actor, in the actor's own
    // department only — the filter carries both, so a head of another department never matches.
    const heads = await readItems<{ department_id: number }>("department", {
        filter: {
            department_id: { _eq: departmentId },
            department_head_id: { _eq: userId },
        },
        fields: ["department_id"],
        limit: 1,
    });

    return { userId, departmentId, isDepartmentHead: heads.length > 0 };
}

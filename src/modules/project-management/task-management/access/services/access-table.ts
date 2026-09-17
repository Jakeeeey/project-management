import { DirectusRequestError, readItems } from "@/modules/project-management/services/directus-client";

/**
 * The physical table behind the access grant, and the one place that knows its name.
 *
 * The table was renamed `pm_task_assigner` -> `pm_task_access`, and a running process can be on
 * either side of that DDL. The permission evaluator reads this table on EVERY capability check, so
 * the name is resolved at runtime rather than hardcoded.
 *
 * The resolved name is cached per process, but a table can be renamed UNDER a running process — that
 * is exactly what the migration does. A cache that only ever falls back would pin a server to the
 * legacy name and break the moment the rename lands, which is why `withAccessTable` re-resolves when
 * the cached name turns out to be stale. The bridge is therefore self-healing in both directions and
 * needs no restart and no deploy ordering.
 *
 * This is deliberately temporary. Once the rename is confirmed in every environment, delete the
 * legacy constant, `resolveAccessTable` and `withAccessTable`, and use `TASK_ACCESS_TABLE` directly.
 */

/** The collection name after the rename. */
export const TASK_ACCESS_TABLE = "pm_task_access";

/** The collection name before the rename, read only while an environment is mid-migration. */
const LEGACY_TASK_ACCESS_TABLE = "pm_task_assigner";

/** Resolved for the life of the process; `null` until the first successful probe. */
let resolvedTable: string | null = null;

/** An unavailable-collection status — the only failure the bridge treats as "wrong name". */
function isUnavailable(error: unknown): boolean {
    return error instanceof DirectusRequestError && (error.status === 403 || error.status === 404);
}

/**
 * Does this collection exist in Directus?
 *
 * The probe filters on an impossible id, so it confirms the collection resolves without reading a
 * row and without depending on which department is asking.
 */
async function collectionExists(collection: string): Promise<boolean> {
    try {
        await readItems(collection, { filter: { id: { _eq: -1 } }, fields: ["id"], limit: 1 });
        return true;
    } catch (error: unknown) {
        if (isUnavailable(error)) return false;
        throw error;
    }
}

/**
 * Resolves which collection the access grant actually lives in, probing once per process.
 *
 * The post-rename name is tried first. Only if it is missing is the legacy name considered, and if
 * neither exists the failure is raised rather than cached — so a genuinely broken Directus is never
 * silently reported as "nobody has access".
 */
export async function resolveAccessTable(): Promise<string> {
    if (resolvedTable !== null) return resolvedTable;

    if (await collectionExists(TASK_ACCESS_TABLE)) {
        resolvedTable = TASK_ACCESS_TABLE;
        return resolvedTable;
    }

    if (await collectionExists(LEGACY_TASK_ACCESS_TABLE)) {
        console.warn(
            `[access] ${TASK_ACCESS_TABLE} is not registered; using the legacy ${LEGACY_TASK_ACCESS_TABLE}. ` +
                "Run the access rename DDL and re-register the collection in Directus to finish the migration.",
        );
        resolvedTable = LEGACY_TASK_ACCESS_TABLE;
        return resolvedTable;
    }

    throw new Error(
        `Neither ${TASK_ACCESS_TABLE} nor the legacy ${LEGACY_TASK_ACCESS_TABLE} is registered in Directus`,
    );
}

/**
 * Runs one operation against the access table, re-resolving once if the cached name has gone stale.
 *
 * This is the only safe way to touch the table: it is what lets a server that resolved the legacy
 * name before a rename keep working after it (and the reverse), with no restart and no deploy order.
 * A second failure is rethrown, so a real outage is never masked by the retry.
 */
export async function withAccessTable<T>(operation: (table: string) => Promise<T>): Promise<T> {
    const table = await resolveAccessTable();

    try {
        return await operation(table);
    } catch (error: unknown) {
        if (!isUnavailable(error)) throw error;

        resolvedTable = null;
        const next = await resolveAccessTable();
        if (next === table) throw error;
        return operation(next);
    }
}
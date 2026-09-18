import { createItems, readItems } from "./directus-client";
import type { ConfigKind, ScopedConfigRow } from "./scoping";
import { phNow } from "../utils/ph-time";
import { CONFIG_COLLECTIONS } from "./task-config-policy";

/**
 * The seed fixture for a department's initial status and priority catalogs.
 *
 * This is the ONLY place status or priority VALUES may appear in code: the fixture is seed-only data
 * and must never be read as a lookup table — runtime labels, colours and ordering always come from
 * the catalog tables, which each department owns.
 *
 * Seeding is idempotent: a kind that already has any live row is left untouched, so a second run (or
 * a run after a partial seed) never duplicates a row. The default flag is set on exactly one row of
 * each kind, so a seeded department can create tasks immediately.
 */

/** One row of the seed fixture. */
interface CatalogSeedRow {
    readonly label: string;
    readonly color: string;
    readonly sort_order: number;
    readonly is_default: number;
}

/** What a seed run did: the row counts created; both zero when the department was already seeded. */
export interface SeedDefaultsResult {
    statusesCreated: number;
    prioritiesCreated: number;
}

const CATALOG_SEED: Record<ConfigKind, readonly CatalogSeedRow[]> = {
    status: [
        { label: "todo", color: "#64748b", sort_order: 0, is_default: 1 },
        { label: "in_progress", color: "#2563eb", sort_order: 1, is_default: 0 },
        { label: "complete", color: "#16a34a", sort_order: 2, is_default: 0 },
    ],
    priority: [
        { label: "low", color: "#64748b", sort_order: 0, is_default: 0 },
        { label: "normal", color: "#2563eb", sort_order: 1, is_default: 1 },
        { label: "high", color: "#f59e0b", sort_order: 2, is_default: 0 },
        { label: "urgent", color: "#dc2626", sort_order: 3, is_default: 0 },
    ],
};

/**
 * Seeds a department's initial catalogs from the fixture above.
 *
 * `actorId` is recorded as the audit author; `null` is the owner's out-of-session bootstrap.
 */
export async function seedDepartmentCatalogs(
    departmentId: number,
    actorId: number | null,
): Promise<SeedDefaultsResult> {
    const statusesCreated = await seedKind(departmentId, "status", actorId);
    const prioritiesCreated = await seedKind(departmentId, "priority", actorId);
    return { statusesCreated, prioritiesCreated };
}

/** Seeds one kind. Returns 0 without writing when the department already owns live rows. */
async function seedKind(departmentId: number, kind: ConfigKind, actorId: number | null): Promise<number> {
    const existing = await readItems<ScopedConfigRow>(CONFIG_COLLECTIONS[kind], {
        filter: {
            department_id: { _eq: departmentId },
            is_deleted: { _eq: 0 },
        },
        fields: ["id"],
        limit: 1,
    });
    if (existing.length > 0) return 0;

    const now = phNow();
    const rows = CATALOG_SEED[kind].map((row) => ({
        department_id: departmentId,
        label: row.label,
        color: row.color,
        sort_order: row.sort_order,
        is_default: row.is_default,
        is_deleted: 0,
        created_at: now,
        created_by: actorId,
        updated_at: now,
        updated_by: actorId,
    }));

    await createItems<unknown>(CONFIG_COLLECTIONS[kind], rows);
    return rows.length;
}

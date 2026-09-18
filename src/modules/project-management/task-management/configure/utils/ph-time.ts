/**
 * The single timestamp producer for the project-management module.
 *
 * Every create/update writes `created_at` / `updated_at` explicitly from here: the `pm_*` tables
 * declare plain `DATETIME NULL` audit columns with no `DEFAULT CURRENT_TIMESTAMP` and no
 * `ON UPDATE CURRENT_TIMESTAMP`, so a timestamp the app does not pass is simply null.
 *
 * `sv-SE` is the one locale whose `toLocaleString` output is exactly the MySQL-compatible
 * `'YYYY-MM-DD HH:mm:ss'` shape, and the zone is pinned to Asia/Manila (UTC+8).
 * Never use `Date.prototype.toISOString()` for an audit field: it emits UTC behind a `T`/`Z`
 * wrapper, which is both the wrong wall-clock time and the wrong shape for these columns.
 *
 * This file imports nothing and uses only erasable syntax (no `enum`, no `namespace`, no
 * parameter properties) so `utils/__assert.ts` can load it through Node's native type stripping.
 */

/**
 * The current wall-clock time in Philippine time.
 *
 * @returns A `'YYYY-MM-DD HH:mm:ss'` string suitable for any `pm_*` audit column.
 */
export function phNow(): string {
    return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Manila" });
}

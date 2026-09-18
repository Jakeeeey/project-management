/**
 * The catalog icon foundation — the ONE allow-list of icon names a status, priority or custom-field
 * option may store, plus the single normaliser every producer and consumer goes through.
 *
 * WHY an allow-list and not free text: an icon name is a foreign key into the lucide-react drawing
 * set compiled into the bundle. A stored name outside that set renders as nothing at best, and at
 * worst forces a dynamic lookup that defeats tree-shaking. So the set is closed and curated here,
 * and a value that does not land in it is treated exactly like a blank one — the caller falls back.
 *
 * The names are lucide's kebab-case icon ids (the spelling the package's own files use), never
 * PascalCase component names, because the stored value is DATA: it has to be comparable in a
 * database column, in a Zod schema and in a plain JSON payload without importing React. The
 * kebab-case -> component map lives only in `CatalogStatusIcon.tsx`, where the drawing happens.
 *
 * `CATALOG_ICON_GROUPS` is the source of truth and `CATALOG_ICON_NAMES` the flat projection of it,
 * so the grouped picker and the validator can never drift apart. The order is the order a picker
 * renders: lifecycle groups first, each group's curated order after that.
 *
 * This file is deliberately import-free and React-free: server code (the scoped loaders, the wire
 * payload shaper and the Zod schemas) loads it alongside the client component, so nothing here may
 * pull React or `lucide-react` into a server bundle.
 */

/**
 * The picker's groups, in render order. `group` is the display label; `names` are the kebab-case
 * lucide ids that group offers. Every name below is a real export of the installed `lucide-react`
 * (verified against the package's icon set) — a name is never invented here, only curated.
 */
export const CATALOG_ICON_GROUPS: { readonly group: string; readonly names: readonly string[] }[] = [
    {
        group: "Not started",
        names: ["circle", "circle-dashed", "circle-dot", "circle-ellipsis", "circle-question-mark", "square-dashed"],
    },
    {
        group: "Active",
        names: [
            "circle-dot-dashed",
            "loader-circle",
            "circle-play",
            "circle-arrow-up",
            "circle-fading-arrow-up",
            "circle-gauge",
            "circle-percent",
            "activity",
        ],
    },
    {
        group: "Blocked / waiting",
        names: [
            "circle-alert",
            "triangle-alert",
            "octagon-alert",
            "circle-slash",
            "circle-x",
            "circle-off",
            "circle-pause",
            "circle-stop",
            "clock",
            "hourglass",
            "circle-minus",
        ],
    },
    {
        group: "Review",
        names: [
            "eye",
            "search",
            "scan-search",
            "circle-check-big",
            "shield-check",
            "verified",
            "message-circle",
            "sparkles",
            "circle-star",
        ],
    },
    {
        group: "Done",
        names: [
            "circle-check",
            "check",
            "check-check",
            "badge-check",
            "circle-power",
            "archive",
            "trophy",
            "rocket",
            "flag",
            "target",
        ],
    },
];

/** Every allow-listed name, in picker order — what the validator and the icon map both enumerate. */
export const CATALOG_ICON_NAMES: readonly string[] = CATALOG_ICON_GROUPS.flatMap((group) => group.names);

/**
 * The icon a row without a stored icon renders, and the fallback for a name that cannot resolve.
 *
 * "circle" rather than `null` because the surfaces that show a status always show SOMETHING: a
 * missing icon must read as an empty lifecycle marker, never as a hole in the row.
 */
export const DEFAULT_CATALOG_ICON = "circle";

/** The one lookup `normalizeIconName` consults; a Set because every stored value is checked here. */
const CATALOG_ICON_NAME_SET: ReadonlySet<string> = new Set(CATALOG_ICON_NAMES);

/** lucide's own namespace prefix, accepted (and dropped) so `lucide-circle` and `circle` agree. */
const LUCIDE_PREFIX = "lucide-";

/**
 * The canonical spelling of a stored icon value, or `null` when there is none.
 *
 * Total by construction — it never throws, whatever a database, a hand-edited request or a stale
 * row hands it, so no render path needs a try/catch:
 * - a non-string (null, a number, an object) is `null`;
 * - a blank or whitespace-only string is `null`;
 * - casing and the `lucide-` prefix are tolerated, because both spellings reach this module from
 *   different producers, and the value is lower-cased before the prefix is stripped so even
 *   `Lucide-Circle` lands as `circle`;
 * - a name outside `CATALOG_ICON_NAMES` is `null`, never a raw pass-through: an unknown name cannot
 *   be rendered and must fall back, not ride the wire.
 */
export function normalizeIconName(raw: unknown): string | null {
    if (typeof raw !== "string") return null;

    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "") return null;

    const name = trimmed.startsWith(LUCIDE_PREFIX) ? trimmed.slice(LUCIDE_PREFIX.length) : trimmed;
    return CATALOG_ICON_NAME_SET.has(name) ? name : null;
}

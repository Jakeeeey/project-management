"use client";

import type { CSSProperties } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * A resolved status or priority catalog row, as the tasks route hands it to the client.
 *
 * Both fields are DATA: `label` is whatever an administrator typed into the department's catalog
 * and `color` is that row's stored colour. Nothing here maps an id to a name, because a hardcoded
 * status/priority map is exactly what the plan forbids — the catalog is the runtime source of
 * truth and a task references it by foreign key.
 */
export interface TaskCatalogRef {
    /** Catalog row label, rendered verbatim. */
    label: string;
    /** 6-digit hex string from the catalog's `color` column, or null/undefined for the default tint. */
    color?: string | null;
}

/** The neutral copy for a reference that no longer resolves to a live catalog row. */
export const NO_STATUS_LABEL = "No status assigned yet";
export const NO_PRIORITY_LABEL = "No priority set";

/** Catalogue colours are user-chosen data; only a plain 6-digit hex is applied as a tint. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Turns a catalog row's stored hex into an inline tint.
 *
 * A CSS custom property / inline style is used instead of a Tailwind class because a class literal
 * cannot express an arbitrary user-chosen colour. Mixing the colour toward `transparent` for the
 * fill and toward `var(--foreground)` for the text keeps the badge legible in both light and dark
 * mode without ever hardcoding `bg-white` / `text-slate-*`. An absent or malformed value returns
 * `undefined`, so the badge falls back to the neutral `outline` styling.
 */
function resolveTint(color: string | null | undefined): CSSProperties | undefined {
    if (typeof color !== "string" || !HEX_COLOR_PATTERN.test(color)) return undefined;

    return {
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
        color: `color-mix(in srgb, ${color} 65%, var(--foreground))`,
    };
}

interface CatalogBadgeProps {
    kind: "status" | "priority";
    /** `null`/`undefined`/blank renders the muted placeholder, never blank and never a stale label. */
    value: TaskCatalogRef | null | undefined;
    placeholder: string;
}

function CatalogBadge({ kind, value, placeholder }: CatalogBadgeProps) {
    const label = value?.label?.trim();

    if (label === undefined || label === "") {
        return (
            <Badge
                variant="outline"
                data-slot={`task-${kind}-badge`}
                data-placeholder="true"
                title={placeholder}
                className="max-w-[140px] truncate border-dashed text-[11px] font-semibold text-muted-foreground"
            >
                {placeholder}
            </Badge>
        );
    }

    return (
        <Badge
            variant="outline"
            data-slot={`task-${kind}-badge`}
            data-placeholder="false"
            title={label}
            style={resolveTint(value?.color)}
            className={cn("max-w-[140px] truncate text-[11px] font-semibold")}
        >
            {label}
        </Badge>
    );
}

export interface TaskStatusBadgeProps {
    status: TaskCatalogRef | null | undefined;
}

/** The status cell's badge: a data-driven label/colour, or the muted "unassigned" placeholder. */
export function TaskStatusBadge({ status }: TaskStatusBadgeProps) {
    return <CatalogBadge kind="status" value={status} placeholder={NO_STATUS_LABEL} />;
}

export interface TaskPriorityBadgeProps {
    priority: TaskCatalogRef | null | undefined;
}

/** The priority cell's badge: a data-driven label/colour, or the muted "unset" placeholder. */
export function TaskPriorityBadge({ priority }: TaskPriorityBadgeProps) {
    return <CatalogBadge kind="priority" value={priority} placeholder={NO_PRIORITY_LABEL} />;
}

export interface TaskRowBadgesProps {
    status: TaskCatalogRef | null | undefined;
    priority: TaskCatalogRef | null | undefined;
}

/** Both badges in one strip — used by the narrow-viewport card, which has no per-column cells. */
export function TaskRowBadges({ status, priority }: TaskRowBadgesProps) {
    return (
        <div data-slot="task-row-badges" className="flex flex-wrap items-center gap-1.5">
            <TaskStatusBadge status={status} />
            <TaskPriorityBadge priority={priority} />
        </div>
    );
}

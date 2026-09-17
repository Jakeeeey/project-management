"use client";

import { CatalogChip } from "@/modules/project-management/components/CatalogChip";

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

/** The dense tree cell's cap — the status/priority columns keep their fixed width. */
const CELL_CHIP_CLASS = "max-w-[140px]";

interface CatalogBadgeProps {
    kind: "status" | "priority";
    /** `null`/`undefined`/blank renders the muted placeholder, never blank and never a stale label. */
    value: TaskCatalogRef | null | undefined;
    placeholder: string;
}

/**
 * The row cell's chip: the module's shared `CatalogChip` in the dense geometry.
 *
 * `TaskCatalogRef` is structurally a `CatalogChipValue`, so the resolved reference and its stored
 * hex pass straight through — the leading dot and its tint come from the catalog row itself.
 */
function CatalogBadge({ kind, value, placeholder }: CatalogBadgeProps) {
    return (
        <CatalogChip
            value={value}
            placeholder={placeholder}
            density="dense"
            className={CELL_CHIP_CLASS}
            data-slot={`task-${kind}-badge`}
        />
    );
}

export interface TaskStatusBadgeProps {
    status: TaskCatalogRef | null | undefined;
}

/** The status cell's chip: a data-driven label/colour/dot, or the muted "unassigned" placeholder. */
export function TaskStatusBadge({ status }: TaskStatusBadgeProps) {
    return <CatalogBadge kind="status" value={status} placeholder={NO_STATUS_LABEL} />;
}

export interface TaskPriorityBadgeProps {
    priority: TaskCatalogRef | null | undefined;
}

/** The priority cell's chip: a data-driven label/colour/dot, or the muted "unset" placeholder. */
export function TaskPriorityBadge({ priority }: TaskPriorityBadgeProps) {
    return <CatalogBadge kind="priority" value={priority} placeholder={NO_PRIORITY_LABEL} />;
}

export interface TaskRowBadgesProps {
    status: TaskCatalogRef | null | undefined;
    priority: TaskCatalogRef | null | undefined;
}

/** Both chips in one strip — used by the narrow-viewport card, which has no per-column cells. */
export function TaskRowBadges({ status, priority }: TaskRowBadgesProps) {
    return (
        <div data-slot="task-row-badges" className="flex flex-wrap items-center gap-1.5">
            <TaskStatusBadge status={status} />
            <TaskPriorityBadge priority={priority} />
        </div>
    );
}

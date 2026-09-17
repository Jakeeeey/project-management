"use client";

import { ArrowDown, ArrowUp, Pencil, Plus, Star, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CatalogChip } from "@/modules/project-management/components/CatalogChip";

import {
    kindLabel,
    kindPlural,
    type CatalogItem,
    type CatalogMoveDirection,
} from "../hooks/useTaskConfiguration";
import type { CatalogKind } from "../types/task-config.schema";

export interface CatalogListProps {
    kind: CatalogKind;
    items: readonly CatalogItem[];
    isSubmitting: boolean;
    onAdd: () => void;
    onEdit: (item: CatalogItem) => void;
    onDelete: (item: CatalogItem) => void;
    onSetDefault: (item: CatalogItem) => void;
    /** Moves the row one position; the caller renumbers and persists the order. */
    onMove: (item: CatalogItem, direction: CatalogMoveDirection) => void;
}

/**
 * Why a row may not be removed, or `null` when it may.
 *
 * The section mirrors the service's two soft-delete guards so a doomed request is never issued: the
 * last live row of a kind, and the row the kind currently defaults to, both stay.
 */
function deleteBlockReason(
    kind: CatalogKind,
    items: readonly CatalogItem[],
    item: CatalogItem,
): string | null {
    if (items.length <= 1) return `At least one ${kind} must remain`;
    if (item.is_default) return `The default ${kind} cannot be removed; make another row the default first`;
    return null;
}

/**
 * One catalog list — the statuses or the priorities of a department.
 *
 * Reordering is explicitly NOT drag-and-drop: two keyboard-accessible buttons move a row one
 * position at a time, which is both simpler and reachable for every input method. The colour is
 * data, applied as an inline `backgroundColor`; it is never turned into a Tailwind class literal.
 */
export function CatalogList({
    kind,
    items,
    isSubmitting,
    onAdd,
    onEdit,
    onDelete,
    onSetDefault,
    onMove,
}: CatalogListProps) {
    const label = kindLabel(kind);
    const plural = kindPlural(kind);

    return (
        <div data-slot={`catalog-list-${kind}`} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-medium">{plural}</h3>
                    <p className="text-xs text-muted-foreground">
                        The {kind} choices a task can reference. Reordering changes the picker order.
                    </p>
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onAdd}
                    disabled={isSubmitting}
                    className="min-h-11 shrink-0 gap-1.5 md:min-h-0"
                >
                    <Plus className="size-4" aria-hidden="true" />
                    Add {label.toLowerCase()}
                </Button>
            </div>

            {items.length === 0 ? (
                <div className="rounded-lg border border-dashed px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">No {plural.toLowerCase()} yet.</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Add one, or seed your department’s defaults.
                    </p>
                </div>
            ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-lg border">
                    {items.map((item, index) => {
                        const blockReason = deleteBlockReason(kind, items, item);

                        return (
                            <li
                                key={item.id}
                                className="flex items-center gap-2 px-3 py-2"
                                data-slot={`catalog-item-${kind}`}
                            >
                                <div className="min-w-0 flex-1">
                                    <CatalogChip
                                        value={item}
                                        density="comfortable"
                                        className="max-w-full"
                                        data-slot={`catalog-chip-${kind}`}
                                    />
                                </div>

                                {item.is_default ? (
                                    <Badge variant="secondary" className="shrink-0 text-[11px]">
                                        Default
                                    </Badge>
                                ) : null}

                                <div className="flex shrink-0 items-center gap-0.5">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => onMove(item, "up")}
                                        disabled={isSubmitting || index === 0}
                                        aria-label={`Move ${item.label} up`}
                                        title={index === 0 ? "Already first" : `Move ${item.label} up`}
                                    >
                                        <ArrowUp className="size-4" aria-hidden="true" />
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => onMove(item, "down")}
                                        disabled={isSubmitting || index === items.length - 1}
                                        aria-label={`Move ${item.label} down`}
                                        title={
                                            index === items.length - 1
                                                ? "Already last"
                                                : `Move ${item.label} down`
                                        }
                                    >
                                        <ArrowDown className="size-4" aria-hidden="true" />
                                    </Button>
                                    {item.is_default ? null : (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            onClick={() => onSetDefault(item)}
                                            disabled={isSubmitting}
                                            aria-label={`Make ${item.label} the default ${kind}`}
                                            title={`Make ${item.label} the default ${kind}`}
                                        >
                                            <Star className="size-4" aria-hidden="true" />
                                        </Button>
                                    )}
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => onEdit(item)}
                                        disabled={isSubmitting}
                                        aria-label={`Edit ${item.label}`}
                                        title={`Edit ${item.label}`}
                                    >
                                        <Pencil className="size-4" aria-hidden="true" />
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => onDelete(item)}
                                        disabled={isSubmitting || blockReason !== null}
                                        aria-label={`Remove ${item.label}`}
                                        title={blockReason ?? `Remove ${item.label}`}
                                    >
                                        <Trash2 className="size-4" aria-hidden="true" />
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

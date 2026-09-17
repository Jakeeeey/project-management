"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { TaskRow, type TaskRowProps } from "../TaskRow";
import { usePrefersReducedMotion, useTreeDnd } from "./TreeDndProvider";

export type SortableTaskRowProps = TaskRowProps;

/**
 * A `TaskRow` made sortable.
 *
 * This is the ONE droppable per row: `useSortable` registers it under the row id, and no second
 * `useDroppable` is created here or anywhere else — a duplicate registration collides in dnd-kit's
 * container map and clobbers the measured rect, so `over` would resolve against the wrong node.
 *
 * The row's own markup is untouched (the top-level `TaskRow` is rendered, not re-implemented); the
 * sortable node ref, transform and drop-indicator classes are forwarded through the optional
 * `rowRef` / `rowStyle` / `rowClassName` props added for this wrapper, and the drag handle goes into
 * the existing `dragHandle` slot.
 *
 * Affordances: a horizontal line marks an insert-before / insert-after position, and a distinct
 * ring marks the nest zone. A row that is a descendant of the dragged row never shows the nest ring
 * (see `resolveDropIntent`). Under reduced motion the transform transition is dropped while both
 * affordances stay.
 */
export function SortableTaskRow({ node, ...rowProps }: SortableTaskRowProps) {
    const { activeId, overId, intent, isOverDescendant, isReorderDisabled } = useTreeDnd();
    const prefersReducedMotion = usePrefersReducedMotion();
    const {
        setNodeRef,
        setActivatorNodeRef,
        attributes,
        listeners,
        transform,
        transition,
    } = useSortable({ id: node.id, disabled: isReorderDisabled });

    const isDragging = activeId === node.id;
    const isDropTarget = overId === node.id && !isDragging;
    const showInsertBefore = isDropTarget && intent === "before";
    const showInsertAfter = isDropTarget && intent === "after";
    const showNest = isDropTarget && intent === "nest" && !isOverDescendant;

    const handleLabel = isReorderDisabled
        ? `Reordering is disabled while a filter or search is active: ${node.title}`
        : `Reorder or move ${node.title}`;

    const rowStyle = {
        transform: CSS.Transform.toString(transform),
        transition: prefersReducedMotion ? undefined : transition,
    };

    const dragHandle = (
        <Button
            ref={setActivatorNodeRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={isReorderDisabled}
            aria-label={handleLabel}
            title={handleLabel}
            data-slot="task-tree-drag-handle"
            className={cn(
                "shrink-0 touch-none text-muted-foreground hover:text-foreground",
                isReorderDisabled ? "cursor-not-allowed opacity-50" : "cursor-grab active:cursor-grabbing",
            )}
            {...(isReorderDisabled ? {} : attributes)}
            {...(isReorderDisabled ? {} : listeners)}
        >
            <GripVertical className="size-3.5" aria-hidden="true" />
        </Button>
    );

    return (
        <TaskRow
            {...rowProps}
            node={node}
            rowRef={setNodeRef}
            rowStyle={rowStyle}
            rowClassName={cn(
                showInsertBefore && "border-t-2 border-t-primary",
                showInsertAfter && "border-b-2 border-b-primary",
                showNest && "bg-primary/5 ring-2 ring-primary/50 ring-inset",
                isDragging && "opacity-40",
            )}
            dragHandle={dragHandle}
        />
    );
}

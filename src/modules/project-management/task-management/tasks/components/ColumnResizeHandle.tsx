"use client";

import {
    useCallback,
    useRef,
    useState,
    type KeyboardEvent,
    type MouseEvent,
    type PointerEvent,
} from "react";

import { cn } from "@/lib/utils";

/**
 * The column resize affordance: an 8px pointer strip pinned to a header cell's right edge.
 *
 * The header label is a potential click target, so this handle must never let a drag reach it: every
 * pointer and click event is stopped (and the pointer default prevented) before it bubbles. That is
 * what keeps a resize from also toggling a header's own behaviour — today the header renders a plain
 * label, and this stays correct if a sort toggle is ever wired onto `TableHead`.
 *
 * Resizing uses POINTER events with capture, so it works for mouse, touch and pen with one code
 * path: `setPointerCapture` keeps the moves coming to the handle even when the pointer leaves it.
 * The live width is reported on every move so the header and its body cells track the pointer; the
 * FINAL width is committed only on release, which is what keeps localStorage out of the drag loop.
 *
 * Keyboard accessible: the strip is a focusable `role="separator"`; Left/Right adjust by a small
 * step, or a large step with Shift held.
 */

/** Arrow-key width step; Shift multiplies it to the large step. */
const KEY_STEP_PX = 16;
const KEY_LARGE_STEP_PX = 64;

export interface ColumnResizeHandleProps {
    /** The column this handle resizes, as it is keyed in the width store (`field-<id>` for custom). */
    readonly columnKey: string;
    /** The column's human label, used in the accessible name ("Resize Task column"). */
    readonly label: string;
    /** The column's current committed width. */
    readonly width: number;
    /** The column's floor — no proposed width may go below it. */
    readonly minWidth: number;
    /** Called on every pointer move with the live width, so the parent can render it immediately. */
    readonly onResize: (columnKey: string, width: number) => void;
    /** Called once on release / keyboard nudge with the final width, so the parent can persist it. */
    readonly onResizeCommit: (columnKey: string, width: number) => void;
}

/** The live drag: the pointer captured, where it started, and the last width it proposed. */
interface ResizeDrag {
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
    lastWidth: number;
}

export function ColumnResizeHandle({
    columnKey,
    label,
    width,
    minWidth,
    onResize,
    onResizeCommit,
}: ColumnResizeHandleProps) {
    const dragRef = useRef<ResizeDrag | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    /** A proposed width brought inside the column's floor and rounded to a whole pixel. */
    const clamp = useCallback(
        (value: number): number => Math.max(minWidth, Math.round(value)),
        [minWidth],
    );

    const handlePointerDown = useCallback(
        (event: PointerEvent<HTMLDivElement>): void => {
            // Stop before the header's own handlers: a resize press is never a header click.
            event.preventDefault();
            event.stopPropagation();
            if (event.button !== 0) return;

            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: width,
                lastWidth: width,
            };
            setIsDragging(true);
        },
        [width],
    );

    const handlePointerMove = useCallback(
        (event: PointerEvent<HTMLDivElement>): void => {
            const drag = dragRef.current;
            if (drag === null || drag.pointerId !== event.pointerId) return;

            event.preventDefault();
            event.stopPropagation();

            const next = clamp(drag.startWidth + (event.clientX - drag.startX));
            drag.lastWidth = next;
            onResize(columnKey, next);
        },
        [clamp, columnKey, onResize],
    );

    /** Shared release for pointer-up and pointer-cancel: end the drag and commit the last width. */
    const endDrag = useCallback(
        (event: PointerEvent<HTMLDivElement>): void => {
            const drag = dragRef.current;
            if (drag === null || drag.pointerId !== event.pointerId) return;

            event.preventDefault();
            event.stopPropagation();
            dragRef.current = null;
            setIsDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
            onResizeCommit(columnKey, drag.lastWidth);
        },
        [columnKey, onResizeCommit],
    );

    const handleClick = useCallback((event: MouseEvent<HTMLDivElement>): void => {
        // A completed drag still fires a click; swallow it so the header never sees it.
        event.preventDefault();
        event.stopPropagation();
    }, []);

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>): void => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

            event.preventDefault();
            event.stopPropagation();

            const step = event.shiftKey ? KEY_LARGE_STEP_PX : KEY_STEP_PX;
            const delta = event.key === "ArrowRight" ? step : -step;
            const next = clamp(width + delta);
            onResize(columnKey, next);
            onResizeCommit(columnKey, next);
        },
        [clamp, columnKey, onResize, onResizeCommit, width],
    );

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${label} column`}
            aria-valuenow={Math.round(width)}
            aria-valuemin={minWidth}
            tabIndex={0}
            title={`Drag to resize the ${label} column`}
            data-slot="task-column-resize"
            data-column-key={columnKey}
            data-resizing={isDragging ? "true" : undefined}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            className="group/handle absolute inset-y-0 right-0 z-10 flex w-2 cursor-col-resize touch-none select-none items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
            {/* A hairline divider that reads as the column edge; it brightens on hover and while dragging. */}
            <span
                aria-hidden="true"
                className={cn(
                    "h-4 w-px rounded-full transition-colors",
                    isDragging ? "bg-primary" : "bg-border group-hover/handle:bg-primary",
                )}
            />
        </div>
    );
}

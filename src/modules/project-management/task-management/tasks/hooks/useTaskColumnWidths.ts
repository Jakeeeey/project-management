"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
    clampTaskColumnWidth,
    defaultTaskColumnWidth,
    readTaskColumnWidths,
    writeTaskColumnWidths,
    DEFAULT_TASK_COLUMN_WIDTHS,
    TASK_COLUMN_WIDTHS_KEY,
    type TaskColumnWidthOverrides,
} from "../components/task-column-widths";

/**
 * The per-user task-column width store, backed by localStorage.
 *
 * `TaskTree` owns this hook and reads widths from it while dragging: the table applies the live
 * width on every pointer move, but the STORE is written once, on release. A drag therefore never
 * touches localStorage per frame — only a committed width does.
 *
 * The store is exposed through `useSyncExternalStore` rather than `useState` + an effect. How wide a
 * column is changes the FIRST rendered table, and this component is server-rendered, so reading
 * localStorage during the initial render would disagree with the server's markup and trip a
 * hydration mismatch. `useSyncExternalStore` gives React a server snapshot of the default layout
 * for that first render, then adopts the stored overrides on the client — with no state written
 * from an effect. The module-level snapshot also survives a storage-denied browser, so a drag still
 * holds for the session even when the write is swallowed.
 *
 * A stored value is validated and clamped by `readTaskColumnWidths`, so a corrupt or absent entry
 * degrades to the default layout and can never break the tasks page.
 */

/** A stable, empty snapshot for the server / hydration render — never reallocated. */
const EMPTY_OVERRIDES: TaskColumnWidthOverrides = {};

/**
 * The in-memory source of truth. `null` means "not read yet"; the first client read seeds it from
 * storage. It is never touched on the server, because the server render uses `getServerOverrides`.
 */
let currentOverrides: TaskColumnWidthOverrides | null = null;

/** Every mounted subscriber; the module-level store notifies them when a width is committed. */
const listeners = new Set<() => void>();

function getOverridesSnapshot(): TaskColumnWidthOverrides {
    if (currentOverrides === null) currentOverrides = readTaskColumnWidths();
    return currentOverrides;
}

function getServerOverrides(): TaskColumnWidthOverrides {
    return EMPTY_OVERRIDES;
}

function notifyOverridesChanged(): void {
    for (const listener of listeners) listener();
}

function subscribeToOverrides(listener: () => void): () => void {
    listeners.add(listener);

    // A write in another tab is the one change this tab did not make itself; re-seed and notify.
    const onStorage = (event: StorageEvent): void => {
        if (event.key !== null && event.key !== TASK_COLUMN_WIDTHS_KEY) return;
        currentOverrides = readTaskColumnWidths();
        listener();
    };
    window.addEventListener("storage", onStorage);

    return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
    };
}

/** Commits the next map: in-memory first (so a denied storage still lasts the session), then disk. */
function setStoredOverrides(next: TaskColumnWidthOverrides): void {
    currentOverrides = next;
    writeTaskColumnWidths(next);
    notifyOverridesChanged();
}

export interface UseTaskColumnWidthsResult {
    /** The fixed defaults merged with the stored overrides (custom columns resolve via `widthFor`). */
    readonly widths: Readonly<Record<string, number>>;
    /** The width of any column key — a fixed key, a custom `field-<id>` key, or the custom default. */
    readonly widthFor: (columnKey: string) => number;
    /** Persists one column's width (clamped to its floor); call this on release, never per frame. */
    readonly setColumnWidth: (columnKey: string, width: number) => void;
}

export function useTaskColumnWidths(): UseTaskColumnWidthsResult {
    const overrides = useSyncExternalStore(
        subscribeToOverrides,
        getOverridesSnapshot,
        getServerOverrides,
    );

    const widths = useMemo<Readonly<Record<string, number>>>(
        () => ({ ...DEFAULT_TASK_COLUMN_WIDTHS, ...overrides }),
        [overrides],
    );

    /**
     * The resolved width of any key. A custom column that was never individually resized is absent
     * from `widths`, so it falls back to the custom-family default.
     */
    const widthFor = useCallback(
        (columnKey: string): number =>
            columnKey in widths ? widths[columnKey] : defaultTaskColumnWidth(columnKey),
        [widths],
    );

    /** One column's committed width; clamped to that column's floor before it is stored. */
    const setColumnWidth = useCallback(
        (columnKey: string, width: number): void => {
            setStoredOverrides({
                ...getOverridesSnapshot(),
                [columnKey]: clampTaskColumnWidth(columnKey, width),
            });
        },
        [],
    );

    return { widths, widthFor, setColumnWidth };
}

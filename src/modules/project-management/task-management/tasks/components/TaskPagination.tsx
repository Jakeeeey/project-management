"use client";

import { ChevronDown, ChevronLeft, ChevronRight, Rows3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Pagination, PaginationContent, PaginationItem } from "@/components/ui/pagination";

/**
 * The task list pager.
 *
 * The pagination unit is a RENDERED ROW, never a root task (see `TasksModule`): one page shows N rows
 * of the flattened visible list, so "Rows per page 10" renders exactly 10 rows even when a root
 * carries a subtree. The accepted trade is that a page boundary can fall inside a subtree; the rows
 * keep their true depth, so those still indent. This component is therefore purely presentational —
 * it receives the already-sliced page's numbers and reports navigation, and it never touches the
 * forest itself.
 *
 * It renders BELOW the tree and outside the grid's horizontal-scroll container, so one pager drives
 * both the wide table and the narrow card layout and neither can carry the controls away when the
 * grid scrolls sideways. Reused module primitives only: the `outline` pill that matches the Filters
 * and Subtasks controls for the page-size picker, and the shared `Button` for the page controls —
 * the anchor-based `PaginationPrevious`/`PaginationNext` are deliberately not used, because an
 * anchor cannot carry the `disabled` attribute a boundary page needs.
 */

/**
 * The page-size choices, smallest first. 25 is the default: 10 fragments a subtree-heavy list into
 * constant paging, while 100 is the fallback for a department that genuinely has thousands of rows.
 * The unit is RENDERED ROWS — see `TasksModule`.
 */
export const TASK_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_TASK_PAGE_SIZE = 25;

/** A page number, or a one-slot gap standing in for a run of skipped pages. */
type PageToken = number | "gap";

/**
 * The compact page list: every page when there are few, otherwise first / last / current +/- 1 with
 * a single gap per run. Keeps the pager a fixed width however many pages the set has, so a
 * thousand-root department does not render a thousand buttons.
 */
function pageTokens(current: number, total: number): PageToken[] {
    if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

    const around = new Set<number>([1, total, current - 1, current, current + 1]);
    const pages = [...around].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);

    const tokens: PageToken[] = [];
    let previous = 0;
    for (const page of pages) {
        if (page - previous > 1) tokens.push("gap");
        tokens.push(page);
        previous = page;
    }
    return tokens;
}

export interface TaskPaginationProps {
    /** The clamped 1-based current page. */
    readonly page: number;
    /** At least 1 — the caller floors this, so an empty set is never reported as page 1 of 0. */
    readonly totalPages: number;
    /** The number of rendered rows in the current (filtered, expanded) set — the page count's numerator. */
    readonly totalRows: number;
    readonly pageSize: number;
    readonly onPageChange: (page: number) => void;
    readonly onPageSizeChange: (pageSize: number) => void;
}

export function TaskPagination({
    page,
    totalPages,
    totalRows,
    pageSize,
    onPageChange,
    onPageSizeChange,
}: TaskPaginationProps) {
    const isSinglePage = totalPages <= 1;
    const rowLabel = `row${totalRows === 1 ? "" : "s"}`;

    /*
     * The summary is the pager's live region: a page change is a change of CONTEXT, not of focus, so
     * a screen reader has nothing to announce unless we say it. Only the summary is polite — the
     * buttons carry their own names, and marking them live too would double-announce every click.
     * On a single page it degrades to a plain count, never a dead "Page 1 of 1".
     */
    const summary = isSinglePage
        ? `${totalRows} ${rowLabel}`
        : `Page ${page} of ${totalPages} · ${totalRows} ${rowLabel}`;

    return (
        <div
            data-slot="task-pagination"
            className="flex flex-col items-center justify-between gap-3 sm:flex-row"
        >
            <p data-slot="task-pagination-summary" className="text-xs text-muted-foreground" aria-live="polite">
                {summary}
            </p>

            <div className="flex items-center gap-2">
                {/*
                 * The page-size picker stays mounted even on a single page. Hiding it together with
                 * the nav would trap the user: picking 100 to collapse a two-page set to one page
                 * would remove the only control that could put the size back. A fixed-size enum, so
                 * it is the module's plain dropdown — never a searchable picker.
                 */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-slot="task-page-size-trigger"
                            aria-label={`Rows per page, currently ${pageSize}`}
                            title={`Rows per page: ${pageSize}`}
                            className="rounded-full"
                        >
                            <Rows3 className="size-4" aria-hidden="true" />
                            <span className="hidden sm:inline">Rows per page</span>
                            <span className="tabular-nums" aria-hidden="true">
                                {pageSize}
                            </span>
                            <ChevronDown className="size-4" aria-hidden="true" />
                        </Button>
                    </DropdownMenuTrigger>

                    <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuLabel>Rows per page</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuRadioGroup
                            value={String(pageSize)}
                            onValueChange={(value) => onPageSizeChange(Number(value))}
                        >
                            {TASK_PAGE_SIZE_OPTIONS.map((option) => (
                                <DropdownMenuRadioItem key={option} value={String(option)}>
                                    {option} rows
                                </DropdownMenuRadioItem>
                            ))}
                        </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                </DropdownMenu>

                {isSinglePage ? null : (
                    <Pagination className="mx-0 w-auto" aria-label="Task list pages">
                        <PaginationContent>
                            <PaginationItem>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon-sm"
                                    data-slot="task-page-previous"
                                    aria-label="Go to previous page"
                                    disabled={page <= 1}
                                    onClick={() => onPageChange(page - 1)}
                                >
                                    <ChevronLeft className="size-4" aria-hidden="true" />
                                </Button>
                            </PaginationItem>

                            {pageTokens(page, totalPages).map((token, index) =>
                                token === "gap" ? (
                                    <PaginationItem key={`gap-${index}`}>
                                        <span
                                            aria-hidden="true"
                                            className="flex size-8 items-center justify-center text-xs text-muted-foreground"
                                        >
                                            …
                                        </span>
                                    </PaginationItem>
                                ) : (
                                    <PaginationItem key={token}>
                                        <Button
                                            type="button"
                                            variant={token === page ? "outline" : "ghost"}
                                            size="icon-sm"
                                            data-slot="task-page-link"
                                            data-active={token === page}
                                            aria-label={`Go to page ${token}`}
                                            /* The current page is conveyed structurally, not by colour. */
                                            aria-current={token === page ? "page" : undefined}
                                            onClick={() => onPageChange(token)}
                                        >
                                            {token}
                                        </Button>
                                    </PaginationItem>
                                ),
                            )}

                            <PaginationItem>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon-sm"
                                    data-slot="task-page-next"
                                    aria-label="Go to next page"
                                    disabled={page >= totalPages}
                                    onClick={() => onPageChange(page + 1)}
                                >
                                    <ChevronRight className="size-4" aria-hidden="true" />
                                </Button>
                            </PaginationItem>
                        </PaginationContent>
                    </Pagination>
                )}
            </div>
        </div>
    );
}

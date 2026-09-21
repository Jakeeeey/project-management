"use client";

import { useState } from "react";
import {
    AlertTriangle,
    ArrowDown,
    ArrowUp,
    Loader2,
    Pencil,
    Plus,
    Trash2,
} from "lucide-react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CatalogChip } from "./CatalogChip";

import { TaskListDialog } from "./TaskListDialog";
import {
    useTaskLists,
    type TaskListMoveDirection,
    type TaskListSummary,
} from "../../tasks/hooks/useTaskLists";

interface EditorState {
    readonly item: TaskListSummary | null;
}

interface PendingDelete {
    readonly item: TaskListSummary;
}

/**
 * Why a list may not be removed, or `null` when it may.
 *
 * The section mirrors the service's two soft-delete guards so a doomed request is never issued: the
 * last live list of a department, and the list that currently serves as its default, both stay. The
 * default has no "make another one the default" escape here on purpose — the flag is server-owned,
 * so the row can never be moved to another list, which is exactly why it is protected.
 *
 * `defaultListId` is the server's EFFECTIVE default (the flagged row, else the lowest), not just the
 * raw flag: the service's refusal resolves the same way, so mirroring the flag alone would let a
 * flagless department attempt a delete the server would refuse.
 */
function deleteBlockReason(
    lists: readonly TaskListSummary[],
    item: TaskListSummary,
    defaultListId: number | null,
): string | null {
    if (lists.length <= 1) return "At least one list must remain";
    if (item.id === defaultListId) return "The default list cannot be removed";
    return null;
}

/**
 * The Task lists section of the Configure page.
 *
 * The section is a SECTION, not a page: there is no route and no sidebar entry for it, because the
 * parent `/project-management` module already authorizes `/project-management/task-management/configure`.
 *
 * It renders nothing at all — not a disabled form, not a lock message — unless the server said
 * `capabilities.canManageDepartmentSetting`, the SAME head-only fact the list CRUD route gates on.
 * A granted member who may edit the catalogs therefore has no way to reach a list write.
 *
 * Reordering is explicitly NOT drag-and-drop: two keyboard-accessible buttons move a row one
 * position at a time, which matches the status/priority catalogs. Task ROW reordering is a
 * different thing and remains absent from the task table; ordering the LISTS themselves is what
 * these controls do.
 */
export function TaskListsSection() {
    const {
        lists,
        isLoading,
        isSubmitting,
        error,
        capabilities,
        refresh,
        createList,
        renameList,
        moveList,
        deleteList,
    } = useTaskLists();

    const [editor, setEditor] = useState<EditorState | null>(null);
    const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

    if (capabilities?.canManageDepartmentSetting !== true) return null;

    const handleSubmit = async (name: string) => {
        if (editor === null) return;
        const saved =
            editor.item === null
                ? await createList(name)
                : await renameList(editor.item.id, name);
        if (saved) setEditor(null);
    };

    const handleConfirmDelete = async () => {
        if (pendingDelete === null) return;
        const removed = await deleteList(pendingDelete.item.id, pendingDelete.item.name);
        if (removed) setPendingDelete(null);
    };

    const handleMove = (item: TaskListSummary, direction: TaskListMoveDirection) => {
        void moveList(item.id, direction);
    };

    const defaultListId = (lists.find((list) => list.is_default) ?? lists[0])?.id ?? null;

    return (
        <section
            data-slot="task-lists-section"
            className="mx-auto w-full max-w-3xl scroll-pt-16 px-4 pb-10 md:scroll-pt-20"
        >
            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1.5">
                            <CardTitle>Task lists</CardTitle>
                            <CardDescription>
                                The lists your department&apos;s tasks live in, and the choices the page
                                switcher offers. Tasks without an explicit list land in the default list,
                                which cannot be removed.
                            </CardDescription>
                        </div>
                        <Button
                            type="button"
                            onClick={() => setEditor({ item: null })}
                            disabled={isSubmitting}
                            className="min-h-11 shrink-0 md:min-h-0"
                        >
                            <Plus className="size-4" aria-hidden="true" />
                            Add list
                        </Button>
                    </div>
                </CardHeader>

                <CardContent className="space-y-4">
                    {error ? (
                        <Alert variant="destructive">
                            <AlertTriangle className="size-4" aria-hidden="true" />
                            <AlertTitle>Task lists error</AlertTitle>
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}

                    {isLoading ? (
                        <div className="space-y-3" aria-hidden="true">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-16 w-full" />
                        </div>
                    ) : lists.length === 0 ? (
                        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                            No lists yet. A default list is created automatically the first time this page
                            loads; add another whenever the department needs one.
                        </p>
                    ) : (
                        <ul
                            data-slot="task-list-settings"
                            className="divide-y divide-border overflow-hidden rounded-lg border"
                        >
                            {lists.map((item, index) => {
                                const blockReason = deleteBlockReason(lists, item, defaultListId);

                                return (
                                    <li
                                        key={item.id}
                                        data-slot="task-list-settings-row"
                                        className="flex items-center gap-2 px-3 py-2"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <CatalogChip
                                                value={{ label: item.name, color: null }}
                                                density="comfortable"
                                                className="max-w-full"
                                                data-slot="task-list-settings-chip"
                                            />
                                        </div>

                                        {item.id === defaultListId ? (
                                            <Badge variant="secondary" className="shrink-0 text-[11px]">
                                                Default
                                            </Badge>
                                        ) : null}

                                        <div className="flex shrink-0 items-center gap-0.5">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => handleMove(item, "up")}
                                                disabled={isSubmitting || index === 0}
                                                aria-label={`Move ${item.name} up`}
                                                title={index === 0 ? "Already first" : `Move ${item.name} up`}
                                            >
                                                <ArrowUp className="size-4" aria-hidden="true" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => handleMove(item, "down")}
                                                disabled={isSubmitting || index === lists.length - 1}
                                                aria-label={`Move ${item.name} down`}
                                                title={
                                                    index === lists.length - 1
                                                        ? "Already last"
                                                        : `Move ${item.name} down`
                                                }
                                            >
                                                <ArrowDown className="size-4" aria-hidden="true" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => setEditor({ item })}
                                                disabled={isSubmitting}
                                                aria-label={`Rename ${item.name}`}
                                                title={`Rename ${item.name}`}
                                            >
                                                <Pencil className="size-4" aria-hidden="true" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => setPendingDelete({ item })}
                                                disabled={isSubmitting || blockReason !== null}
                                                aria-label={`Remove ${item.name}`}
                                                title={blockReason ?? `Remove ${item.name}`}
                                            >
                                                <Trash2 className="size-4" aria-hidden="true" />
                                            </Button>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    <div className="flex justify-end">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                void refresh();
                            }}
                            disabled={isLoading || isSubmitting}
                            className="min-h-11 md:min-h-0"
                        >
                            {isLoading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                            Refresh
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <TaskListDialog
                key={editor === null ? "task-list-dialog" : `list-${editor.item?.id ?? "new"}`}
                open={editor !== null}
                onOpenChange={(open) => {
                    if (!open) setEditor(null);
                }}
                item={editor?.item ?? null}
                isSubmitting={isSubmitting}
                onSubmit={handleSubmit}
            />

            <AlertDialog
                open={pendingDelete !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingDelete(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove this list?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {pendingDelete === null
                                ? ""
                                : `“${pendingDelete.item.name}” leaves the switcher. Tasks that already reference it keep that reference stored, but the list can no longer be selected, so remove or re-list them first if they are still in use.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={isSubmitting}
                            onClick={() => {
                                void handleConfirmDelete();
                            }}
                        >
                            Remove list
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}

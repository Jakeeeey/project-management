"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

import {
    kindLabel,
    useTaskConfiguration,
    type CatalogFormInput,
    type CatalogItem,
    type CatalogMoveDirection,
} from "../hooks/useTaskConfiguration";
import type { CatalogKind } from "../types/task-config.schema";
import { CatalogItemDialog } from "./CatalogItemDialog";
import { CatalogList } from "./CatalogList";

interface EditorState {
    readonly kind: CatalogKind;
    readonly item: CatalogItem | null;
}

interface PendingDelete {
    readonly kind: CatalogKind;
    readonly item: CatalogItem;
}

/**
 * The Task configuration section of the existing Settings page.
 *
 * The section is a SECTION, not a page: there is no route and no sidebar entry for it, because the
 * parent `/project-management` module already authorizes `/project-management/settings`.
 *
 * It renders nothing at all — not a disabled form, not a lock message — unless the server said
 * `capabilities.canConfigure`. That flag is read from the configuration route and never derived
 * here, so a plain member has no way to reach a catalog write and never sees the section in the DOM.
 */
export function TaskConfigurationSection() {
    const {
        statuses,
        priorities,
        isLoading,
        isSubmitting,
        error,
        capabilities,
        refresh,
        createItem,
        updateItem,
        deleteItem,
        setDefault,
        moveItem,
        seedDefaults,
    } = useTaskConfiguration();

    const [editor, setEditor] = useState<EditorState | null>(null);
    const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

    if (capabilities?.canConfigure !== true) return null;

    const handleSubmit = async (values: CatalogFormInput) => {
        if (editor === null) return;

        const saved =
            editor.item === null
                ? await createItem(editor.kind, values)
                : await updateItem(editor.kind, editor.item.id, values, editor.item.label);

        if (saved) setEditor(null);
    };

    const handleConfirmDelete = async () => {
        if (pendingDelete === null) return;
        const removed = await deleteItem(pendingDelete.kind, pendingDelete.item.id, pendingDelete.item.label);
        if (removed) setPendingDelete(null);
    };

    const handleMove = (kind: CatalogKind, item: CatalogItem, direction: CatalogMoveDirection) => {
        void moveItem(kind, item.id, direction);
    };

    return (
        <section
            data-slot="task-configuration-section"
            className="mx-auto w-full max-w-3xl scroll-pt-16 px-4 pb-10 md:scroll-pt-20"
        >
            <Card>
                <CardHeader>
                    <CardTitle>Task configuration</CardTitle>
                    <CardDescription>
                        This department owns its own statuses and priorities. Every task references one of
                        each, so these lists are the board&apos;s source of truth.
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-6">
                    {error ? (
                        <Alert variant="destructive">
                            <AlertTriangle className="size-4" aria-hidden="true" />
                            <AlertTitle>Task configuration error</AlertTitle>
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}

                    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">Start from our defaults</p>
                            <p className="text-xs text-muted-foreground">
                                Adds the standard statuses and priorities once. Running it again changes nothing.
                            </p>
                        </div>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                                void seedDefaults();
                            }}
                            disabled={isSubmitting}
                            className="min-h-11 shrink-0 md:min-h-0"
                        >
                            {isSubmitting ? (
                                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            ) : (
                                <Sparkles className="size-4" aria-hidden="true" />
                            )}
                            Seed defaults for my department
                        </Button>
                    </div>

                    {isLoading ? (
                        <div className="space-y-3" aria-hidden="true">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-20 w-full" />
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-20 w-full" />
                        </div>
                    ) : (
                        <>
                            <CatalogList
                                kind="status"
                                items={statuses}
                                isSubmitting={isSubmitting}
                                onAdd={() => setEditor({ kind: "status", item: null })}
                                onEdit={(item) => setEditor({ kind: "status", item })}
                                onDelete={(item) => setPendingDelete({ kind: "status", item })}
                                onSetDefault={(item) => {
                                    void setDefault("status", item.id, item.label);
                                }}
                                onMove={(item, direction) => handleMove("status", item, direction)}
                            />

                            <Separator />

                            <CatalogList
                                kind="priority"
                                items={priorities}
                                isSubmitting={isSubmitting}
                                onAdd={() => setEditor({ kind: "priority", item: null })}
                                onEdit={(item) => setEditor({ kind: "priority", item })}
                                onDelete={(item) => setPendingDelete({ kind: "priority", item })}
                                onSetDefault={(item) => {
                                    void setDefault("priority", item.id, item.label);
                                }}
                                onMove={(item, direction) => handleMove("priority", item, direction)}
                            />
                        </>
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
                            Refresh
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <CatalogItemDialog
                key={editor === null ? "catalog-item-dialog" : `${editor.kind}-${editor.item?.id ?? "new"}`}
                open={editor !== null}
                onOpenChange={(open) => {
                    if (!open) setEditor(null);
                }}
                kind={editor?.kind ?? "status"}
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
                        <AlertDialogTitle>
                            Remove this {pendingDelete === null ? "row" : pendingDelete.kind}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {pendingDelete === null
                                ? ""
                                : `“${pendingDelete.item.label}” leaves the picker. Tasks still pointing at it show the unassigned placeholder, so re-point them first if they are in use.`}
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
                            Remove {pendingDelete === null ? "" : kindLabel(pendingDelete.kind).toLowerCase()}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}

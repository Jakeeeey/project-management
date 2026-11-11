"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Pencil, Plus, Tags as TagsIcon, Trash2 } from "lucide-react";

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
import { Skeleton } from "@/components/ui/skeleton";

import { useTagCatalog, type TagInput, type TagRow } from "../hooks/useTagCatalog";
import { useConfigureCapabilities } from "../hooks/useConfigureCapabilities";
import { CatalogChip } from "./CatalogChip";
import { TagDialog } from "./TagDialog";

/**
 * The Tags section of the Configure page: the department's own reusable labels.
 *
 * A tag is many-to-many with tasks on purpose — the alternative, a column on `pm_task`, would cap a
 * task at one label and force a schema change for every new kind of label. So this page only manages
 * the catalog; which tasks carry a tag is decided on the task itself.
 *
 * Retiring a tag soft-deletes it. Rows already pointing at it keep pointing at it (the task list
 * simply stops resolving the label), and adding the same name again revives the retired row rather
 * than creating a second one — that is why the copy says the tag leaves the picker rather than that
 * it is deleted.
 */
export function TagsSection() {
    const canConfigure = useConfigureCapabilities();
    const { tags, isLoading, isSubmitting, error, refresh, createTag, updateTag, deleteTag } = useTagCatalog();

    const [editing, setEditing] = useState<TagRow | null>(null);
    const [isAdding, setIsAdding] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<TagRow | null>(null);

    // Unknown capability stays enabled: `null` means the answer has not arrived, never "denied".
    if (canConfigure === false) return null;

    const handleSubmit = async (input: TagInput): Promise<boolean> =>
        editing === null ? createTag(input) : updateTag(editing.id, input);

    const handleConfirmDelete = async () => {
        if (pendingDelete === null) return;
        const removed = await deleteTag(pendingDelete.id, pendingDelete.label);
        if (removed) setPendingDelete(null);
    };

    return (
        <section
            data-slot="configure-section"
            className="mx-auto w-full max-w-3xl scroll-pt-16 px-4 pb-10 md:scroll-pt-20"
        >
            <Card>
                <CardHeader>
                    <CardTitle>Tags</CardTitle>
                    <CardDescription>
                        Labels your department can put on tasks — as many per task as you need. Tags are
                        shared, so the names below are what everyone picks from.
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4">
                    {error ? (
                        <Alert variant="destructive">
                            <AlertTriangle className="size-4" aria-hidden="true" />
                            <AlertTitle>Tag error</AlertTitle>
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}

                    <div className="flex items-center justify-between gap-3">
                        <p className="text-sm text-muted-foreground">
                            {tags.length === 0 ? "No tags yet" : `${tags.length} ${tags.length === 1 ? "tag" : "tags"}`}
                        </p>
                        <Button
                            type="button"
                            onClick={() => {
                                setEditing(null);
                                setIsAdding(true);
                            }}
                            disabled={isSubmitting}
                            className="min-h-11 md:min-h-0"
                        >
                            <Plus className="size-4" aria-hidden="true" />
                            Add tag
                        </Button>
                    </div>

                    {isLoading ? (
                        <div className="space-y-2" aria-hidden="true">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    ) : tags.length === 0 ? (
                        <div className="rounded-lg border border-dashed p-8 text-center">
                            <TagsIcon className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
                            <p className="mt-2 text-sm font-medium">No tags yet</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Add the first one, then put it on tasks from the task dialog or the List view.
                            </p>
                        </div>
                    ) : (
                        <ul className="divide-y rounded-lg border" data-slot="tag-list">
                            {tags.map((tag) => (
                                <li key={tag.id} className="flex items-center gap-2 px-3 py-2" data-slot="tag-item">
                                    <div className="min-w-0 flex-1">
                                        <CatalogChip value={tag} density="comfortable" className="max-w-full" />
                                    </div>
                                    <div className="flex shrink-0 items-center gap-0.5">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`Edit ${tag.label}`}
                                            title={`Edit ${tag.label}`}
                                            disabled={isSubmitting}
                                            onClick={() => {
                                                setEditing(tag);
                                                setIsAdding(true);
                                            }}
                                        >
                                            <Pencil className="size-4" aria-hidden="true" />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`Remove ${tag.label}`}
                                            title={`Remove ${tag.label}`}
                                            disabled={isSubmitting}
                                            onClick={() => setPendingDelete(tag)}
                                        >
                                            <Trash2 className="size-4" aria-hidden="true" />
                                        </Button>
                                    </div>
                                </li>
                            ))}
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

            {/* Mounted only while open: a dialog that stays mounted behind `open={false}` would need
                an effect to re-seed its fields, and closing it unmounts the state with it. */}
            {isAdding ? (
                <TagDialog
                    key={editing === null ? "tag-dialog-new" : `tag-dialog-${editing.id}`}
                    tag={editing}
                    isSubmitting={isSubmitting}
                    onSubmit={handleSubmit}
                    onCancel={() => {
                        setIsAdding(false);
                        setEditing(null);
                    }}
                />
            ) : null}

            <AlertDialog
                open={pendingDelete !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingDelete(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove this tag?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {pendingDelete === null
                                ? ""
                                : `“${pendingDelete.label}” leaves the picker. Tasks that carry it keep the row but stop showing the label, and adding the same name again brings the tag back.`}
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
                            Remove tag
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}

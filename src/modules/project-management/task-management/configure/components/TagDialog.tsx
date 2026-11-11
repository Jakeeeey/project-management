"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { TagInput, TagRow } from "../hooks/useTagCatalog";
import { CatalogIconPicker } from "../../tasks/components/CatalogIconPicker";
import { CatalogChip } from "./CatalogChip";

/** The seeded colour a brand-new tag starts on, so the swatch is never empty. */
const DEFAULT_TAG_HEX = "#64748b";

const MAX_LABEL_LENGTH = 100;

interface TagDialogProps {
    /** The tag being edited, or `null` when adding one. */
    readonly tag: TagRow | null;
    readonly isSubmitting: boolean;
    /** Resolves `true` when the write succeeded, which is what closes the dialog. */
    readonly onSubmit: (input: TagInput) => Promise<boolean>;
    readonly onCancel: () => void;
}

/**
 * Add or edit one tag. Two fields and no form library — the catalog dialog next door carries a form
 * because it juggles seven fields across two catalog kinds; copying that machinery here would be
 * scaffolding for a shape that does not exist.
 *
 * The caller mounts this only while it is open, so the two fields seed from props on mount and a
 * cancelled edit cannot leak into the next one. That is also why there is no `open` prop and no
 * effect: a dialog mounted behind `open={false}` would need a synchronisation effect to re-seed,
 * which is exactly the cascading render React warns about.
 *
 * The colour field mirrors the catalog dialog's contract: a hex input plus a native picker, and an
 * empty hex means "no colour" (`null`), never an empty string, because the server stores the absence.
 *
 * The icon field is the catalog dialog's picker with `allowAnyIcon`: a status icon comes from a closed
 * lifecycle vocabulary, a tag icon does not, so every lucide drawing is offered and the stored value
 * is whatever the administrator picked. Omitting it is a valid state — the chip falls back to a glyph.
 */
export function TagDialog({ tag, isSubmitting, onSubmit, onCancel }: TagDialogProps) {
    const [label, setLabel] = useState(tag?.label ?? "");
    const [color, setColor] = useState<string | null>(tag?.color ?? null);
    const [icon, setIcon] = useState<string | null>(tag?.icon ?? null);
    const [error, setError] = useState<string | null>(null);

    const trimmedLabel = label.trim();
    const isValid = trimmedLabel.length > 0 && trimmedLabel.length <= MAX_LABEL_LENGTH;

    const handleSubmit = async () => {
        if (!isValid) {
            setError("Give the tag a name of 100 characters or fewer.");
            return;
        }
        const saved = await onSubmit({ label: trimmedLabel, color, icon });
        if (saved) onCancel();
    };

    return (
        <Dialog open onOpenChange={(open) => {
            if (!open) onCancel();
        }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{tag === null ? "Add a tag" : "Edit tag"}</DialogTitle>
                    <DialogDescription>
                        Tags are shared by everyone in your department, so a name one person uses is
                        the name everyone sees.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="tag-label">Name</Label>
                        <Input
                            id="tag-label"
                            value={label}
                            maxLength={MAX_LABEL_LENGTH}
                            autoComplete="off"
                            placeholder="Needs review"
                            onChange={(event) => {
                                setLabel(event.target.value);
                                setError(null);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && isValid && !isSubmitting) {
                                    event.preventDefault();
                                    void handleSubmit();
                                }
                            }}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="tag-color">Colour</Label>
                        <div className="flex items-center gap-2">
                            <input
                                type="color"
                                aria-label="Pick a colour for this tag"
                                className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
                                value={color ?? DEFAULT_TAG_HEX}
                                onChange={(event) => setColor(event.target.value)}
                            />
                            <Input
                                id="tag-color"
                                placeholder="#16a34a"
                                autoComplete="off"
                                className="font-mono"
                                value={color ?? ""}
                                onChange={(event) => {
                                    const next = event.target.value.trim();
                                    setColor(next === "" ? null : next);
                                }}
                            />
                            {color === null ? null : (
                                <Button type="button" variant="ghost" size="sm" onClick={() => setColor(null)}>
                                    Clear
                                </Button>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Optional 6-digit hex, such as #16a34a. Shown as the chip tint.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="tag-icon">Icon</Label>
                        <CatalogIconPicker
                            id="tag-icon"
                            value={icon}
                            color={color}
                            allowAnyIcon
                            disabled={isSubmitting}
                            onChange={(next) => setIcon(next)}
                        />
                        <p className="text-xs text-muted-foreground">
                            Any lucide icon. Shown inside the chip beside the name.
                        </p>
                    </div>

                    <div className="rounded-lg border bg-muted/30 p-3">
                        <p className="text-xs font-medium text-muted-foreground">Preview</p>
                        <div className="mt-2">
                            <CatalogChip
                                value={{ label: trimmedLabel || "Tag name", color, icon }}
                                density="comfortable"
                            />
                        </div>
                    </div>

                    {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
                </div>

                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting || !isValid}>
                        {isSubmitting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                        {tag === null ? "Add tag" : "Save changes"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

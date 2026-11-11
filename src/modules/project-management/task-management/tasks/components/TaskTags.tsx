"use client";

import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { Tag } from "lucide-react";
import { resolveCatalogForeground, resolveCatalogHex } from "./CatalogChip";
import { CatalogStatusIcon, toAnyIconName } from "./CatalogStatusIcon";
import type { TaskTagOption, TaskTagRef } from "../hooks/useTasks";

/**
 * The tag surfaces shared by the table, the detail sheet and the form dialog.
 *
 * A task row carries only tag ids (`TaskTagRef`); label and colour live once in the department's
 * catalog (`TaskCatalogs.tags`). Both surfaces here resolve through that catalog, so a renamed or
 * recoloured tag changes everywhere without touching a task row — which is also why a resolution
 * costs a scan of a list that is small by definition (a department's tags).
 *
 * The stack mirrors `AssigneeStack` on purpose: a tag is a many-per-task reference picked from a
 * department catalog, exactly like an assignee, so both cells read as an overlapping circle group
 * with a `+N` overflow and both open the same style of modal to change it. The circle carries the
 * tag's own icon when it has one (tags accept ANY lucide id) and the label's initials otherwise.
 */

/** The row's tag ids resolved against the catalog; an id with no live catalog row is dropped. */
export function resolveTaskTags(
    refs: readonly TaskTagRef[],
    catalog: readonly TaskTagOption[],
): TaskTagOption[] {
    if (refs.length === 0 || catalog.length === 0) return [];

    const tags: TaskTagOption[] = [];
    for (const ref of refs) {
        const tag = catalog.find((entry) => entry.id === ref.tag_id);
        if (tag !== undefined) tags.push(tag);
    }
    return tags;
}

/** "qa-tag-check" → "QC"; a one-word label keeps its first two characters. */
function initialsOfTag(label: string): string {
    const parts = label.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (parts.length === 0) return "?";
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : parts[0].charAt(1);
    return `${first}${last ?? ""}`.toUpperCase();
}

export interface TaskTagStackProps {
    /** The resolved tags, in the order the catalog gives them. */
    readonly tags: readonly TaskTagOption[];
    /** How many circles render before the rest collapse into a `+N` pill. At least one is shown. */
    readonly max?: number;
    readonly className?: string;
    /** `"text"` keeps the explanatory words; `"icon"` swaps them for a quiet glyph in a dense cell. */
    readonly emptyVariant?: "text" | "icon";
}

/**
 * The tag cell: overlapping circles with a `+N` overflow pill.
 *
 * The circles are presentational (the cell's own button is the control), so each is exposed as an
 * image labelled with its tag and a `title` tooltip, and the empty state is muted words or an
 * aria-hidden glyph with the words behind it.
 */
export function TaskTagStack({
    tags,
    max = 3,
    className,
    emptyVariant = "text",
}: TaskTagStackProps) {
    if (tags.length === 0) {
        if (emptyVariant === "icon") {
            return (
                <span
                    data-slot="task-tag-stack-empty"
                    title="No tags"
                    className="inline-flex items-center text-muted-foreground"
                >
                    <Tag className="size-4" aria-hidden="true" />
                    <span className="sr-only">No tags</span>
                </span>
            );
        }

        return (
            <span data-slot="task-tag-stack-empty" className="text-xs text-muted-foreground">
                No tags
            </span>
        );
    }

    const visible = tags.slice(0, Math.max(1, max));
    const overflow = tags.length - visible.length;
    const allLabels = tags.map((tag) => tag.label).join(", ");

    return (
        <AvatarGroup
            data-slot="task-tag-stack"
            aria-label={`Tags: ${allLabels}`}
            className={cn("w-fit", className)}
        >
            {visible.map((tag) => {
                /*
                 * The tag's own hex is the fill, and its readable ink comes from the same
                 * luminance rule the status and priority chips use. A tag with no colour keeps a
                 * neutral circle rather than borrowing a palette it does not belong to.
                 */
                const hex = resolveCatalogHex(tag.color ?? null);
                const style =
                    hex === null
                        ? undefined
                        : { backgroundColor: hex, color: resolveCatalogForeground(hex) };

                return (
                    <Avatar
                        key={tag.id}
                        size="sm"
                        role="img"
                        aria-label={tag.label}
                        title={tag.label}
                    >
                        <AvatarFallback style={style}>
                            {toAnyIconName(tag.icon) === null ? (
                                initialsOfTag(tag.label)
                            ) : (
                                <CatalogStatusIcon
                                    icon={tag.icon}
                                    color={tag.color}
                                    tone={hex === null ? "status" : "contrast"}
                                    density="dense"
                                />
                            )}
                        </AvatarFallback>
                    </Avatar>
                );
            })}

            {overflow > 0 && (
                <AvatarGroupCount
                    data-slot="task-tag-stack-overflow"
                    title={`${overflow} more tag${overflow === 1 ? "" : "s"}`}
                    aria-label={`${overflow} more tag${overflow === 1 ? "" : "s"}`}
                    className="size-6 text-[10px]"
                >
                    +{overflow}
                </AvatarGroupCount>
            )}
        </AvatarGroup>
    );
}

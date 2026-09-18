"use client";

import {
    Avatar,
    AvatarFallback,
    AvatarGroup,
    AvatarGroupCount,
    AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { UserPlus } from "lucide-react";
import {
    assigneeColorFor,
    assigneeForegroundFor,
} from "./assignee-color";

/**
 * One assigned member, as the tasks route resolves it.
 *
 * `user_id` is the stable key (and the value the assignees route takes); the display fields are
 * denormalised onto the row so the tree needs no second lookup per cell.
 */
export interface TaskAssigneeView {
    user_id: number;
    full_name: string;
    avatar_url?: string | null;
}

export interface AssigneeStackProps {
    assignees: readonly TaskAssigneeView[];
    /** How many avatars render before the rest collapse into a `+N` pill. At least one is shown. */
    max?: number;
    className?: string;
    /**
     * How the zero-assignee state renders. `"text"` (the default) keeps the explanatory words for
     * surfaces with room for a sentence; `"icon"` swaps them for a quiet `UserPlus` glyph, which
     * fits a dense table cell where a 12-character string would truncate. Opt-in so the default
     * stays byte-for-byte the previous behaviour.
     */
    emptyVariant?: "text" | "icon";
}

/** "Maria Santos" → "MS"; a single-word name keeps its first letter. */
function initialsOf(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
    return `${first}${last}`.toUpperCase();
}

/**
 * The assignee cell: overlapping avatars with a `+N` overflow pill.
 *
 * Avatars are not interactive, so each one is exposed as an image with its member name (and a
 * `title` tooltip) rather than as a control — the full name is reachable even when only initials
 * render. An empty assignment is never an empty cell: it renders the muted "No assignees", or a
 * muted `UserPlus` glyph when the caller asks for the `icon` variant.
 */
export function AssigneeStack({
    assignees,
    max = 3,
    className,
    emptyVariant = "text",
}: AssigneeStackProps) {
    if (assignees.length === 0) {
        if (emptyVariant === "icon") {
            /*
             * Presentational only: this cell already owns the assignee edit affordance, so the glyph
             * is NOT a second control (no click or focus target). It is aria-hidden, with the words
             * below as the accessible name, so the empty state is never silent to a screen reader.
             */
            return (
                <span
                    data-slot="assignee-stack-empty"
                    title="No assignees"
                    className="inline-flex items-center text-muted-foreground"
                >
                    <UserPlus className="size-4" aria-hidden="true" />
                    <span className="sr-only">No assignees</span>
                </span>
            );
        }

        return (
            <span data-slot="assignee-stack-empty" className="text-xs text-muted-foreground">
                No assignees
            </span>
        );
    }

    const visible = assignees.slice(0, Math.max(1, max));
    const overflow = assignees.length - visible.length;
    const allNames = assignees.map((assignee) => assignee.full_name).join(", ");

    return (
        <AvatarGroup
            data-slot="assignee-stack"
            aria-label={`Assignees: ${allNames}`}
            className={cn("w-fit", className)}
        >
            {visible.map((assignee) => {
                /*
                 * The FALLBACK is tinted from the user id, so a member without a photo is still
                 * recognisable at a glance and matches their chip in the assign picker. The colour
                 * and its readable ink both come from the one derived-colour module; the `+N` pill
                 * below stays neutral, because it stands for a count, not a person.
                 */
                const fill = assigneeColorFor(assignee.user_id);

                return (
                    <Avatar
                        key={assignee.user_id}
                        size="sm"
                        role="img"
                        aria-label={assignee.full_name}
                        title={assignee.full_name}
                    >
                        {assignee.avatar_url ? (
                            <AvatarImage src={assignee.avatar_url} alt={assignee.full_name} />
                        ) : null}
                        <AvatarFallback
                            style={{ backgroundColor: fill, color: assigneeForegroundFor(fill) }}
                        >
                            {initialsOf(assignee.full_name)}
                        </AvatarFallback>
                    </Avatar>
                );
            })}

            {overflow > 0 && (
                <AvatarGroupCount
                    data-slot="assignee-stack-overflow"
                    title={`${overflow} more assignee${overflow === 1 ? "" : "s"}`}
                    aria-label={`${overflow} more assignee${overflow === 1 ? "" : "s"}`}
                    className="size-6 text-[10px]"
                >
                    +{overflow}
                </AvatarGroupCount>
            )}
        </AvatarGroup>
    );
}

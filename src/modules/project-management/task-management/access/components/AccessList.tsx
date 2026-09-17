"use client";

import { useState } from "react";
import { AlertTriangle, RotateCcw, ShieldCheck, UserMinus, UserPlus, Users } from "lucide-react";

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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import type { MemberAccessItem } from "../hooks/useAccess";
import { AccessGrantDialog } from "./AccessGrantDialog";

/**
 * The three columns every viewer gets: member, access state, and the grant's provenance. The
 * actions column is appended ONLY when the actor may grant (`canGrant`), so a member who cannot
 * grant never has the control in the DOM — not hidden, not disabled.
 *
 * `canGrant` is policy-dependent: while "Allow all members Edit access" is ON, every member may
 * grant — but the whole card is then muted and `inert` (see `policyOpen`), because a per-member
 * grant is moot once the policy already gives everybody access.
 */
const BASE_COLUMN_COUNT = 3;

export interface AccessListProps {
    items: readonly MemberAccessItem[];
    isLoading: boolean;
    isSubmitting: boolean;
    error: string | null;
    /** Server-resolved `capabilities.canGrant` — read from the route, never derived on the client. */
    canGrant: boolean;
    /**
     * True while the department's "Allow all members Edit access" policy is ON. Every member then
     * already holds Edit access, so the whole per-member control is moot: the card is muted and
     * taken out of interaction rather than removed, so the roster stays readable while making it
     * unmistakable that there is nothing to grant here.
     */
    policyOpen: boolean;
    /** Member names by user id, so `granted_by` can be shown as a person rather than a number. */
    memberNameById: ReadonlyMap<number, string>;
    onGrant: (userId: number, label: string) => Promise<boolean>;
    onRevoke: (grantId: number, label: string) => Promise<boolean>;
    onRefresh: () => void;
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
 * The provenance of a member's grant: the name of the head who issued it when that head is still in
 * the department, `User #<id>` when they are not, and an explicit "Not granted" otherwise. Never an
 * empty cell, because "no grant" is a legitimate state worth naming.
 */
function provenanceLabel(
    member: MemberAccessItem,
    memberNameById: ReadonlyMap<number, string>,
): string {
    if (!member.is_granted) return "Not granted";
    if (member.granted_by === null) return "Unknown";
    return memberNameById.get(member.granted_by) ?? `User #${member.granted_by}`;
}

/**
 * The access-state pill, shared by the wide table row and the narrow-viewport card.
 *
 * It reads EFFECTIVE access, not the grant row: while the department policy is ON every member has
 * Edit access whether or not a grant exists, so rendering the raw grant state would tell the head
 * "Cannot edit" about people who can. The caller ORs the policy in.
 */
function AccessStateBadge({ hasEdit }: { hasEdit: boolean }) {
    if (hasEdit) {
        return (
            <Badge variant="secondary" className="max-w-full truncate" data-slot="grant-state">
                <ShieldCheck aria-hidden="true" />
                Can edit
            </Badge>
        );
    }

    return (
        <Badge
            variant="outline"
            className="max-w-full truncate text-muted-foreground"
            data-slot="grant-state"
        >
            Cannot edit
        </Badge>
    );
}

interface RevokeButtonProps {
    member: MemberAccessItem;
    isSubmitting: boolean;
    onRevoke: (member: MemberAccessItem) => void;
    /** The card surface passes `min-h-11` so the touch target reaches 44px; the table does not. */
    className?: string;
}

/** The ONE row action, shared by both surfaces so the card fallback cannot drift from the table. */
function RevokeButton({ member, isSubmitting, onRevoke, className }: RevokeButtonProps) {
    const label = `Revoke Edit access from ${member.full_name}`;

    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRevoke(member)}
            disabled={isSubmitting}
            aria-label={label}
            title={label}
            className={cn(className)}
        >
            <UserMinus className="size-4" aria-hidden="true" />
            Revoke
        </Button>
    );
}

/**
 * The Access roster.
 *
 * Renders the department's live members with their access state and, when the server said
 * `capabilities.canGrant`, the actions that change it. `canGrant` is a prop read straight off the
 * route payload: the component never inspects a session, a role or a user id — which is why a
 * non-head's page simply has no grant trigger to find.
 *
 * Two surfaces carry the same roster, the same fields and the same action: a table at `xl` and
 * above, and a stacked card list below it. A four-column grid with a `min-w-[640px]` floor is
 * unusable on a phone — the member name, access state and action all sit off-screen inside a
 * horizontal scroller — so the narrow view gets cards, where inner truncation becomes `break-words`.
 *
 * States are explicit and never blank: skeleton rows while loading, a centered muted empty state for
 * a department with no members, and a persistent destructive alert for a failed load (the toast is
 * an addition, never the only surface).
 *
 * Granting goes through `AccessGrantDialog` (a searchable, capped member picker) and revoking through
 * a confirm, so both writes are deliberate. Only the live grant row's id is ever used to revoke, and
 * that id comes from the route's per-member `grant_id`.
 */
export function AccessList({
    items,
    isLoading,
    isSubmitting,
    error,
    canGrant,
    policyOpen,
    memberNameById,
    onGrant,
    onRevoke,
    onRefresh,
}: AccessListProps) {
    const [isGrantDialogOpen, setIsGrantDialogOpen] = useState(false);
    const [pendingRevoke, setPendingRevoke] = useState<MemberAccessItem | null>(null);

    const columnCount = canGrant ? BASE_COLUMN_COUNT + 1 : BASE_COLUMN_COUNT;
    const candidates = items.filter((member) => !member.is_granted);
    const showError = error !== null && error !== "";
    const isEmpty = !isLoading && !showError && items.length === 0;

    const handleGrantSubmit = async (userId: number) => {
        const member = items.find((entry) => entry.user_id === userId);
        const saved = await onGrant(userId, member?.full_name ?? "The member");
        if (saved) setIsGrantDialogOpen(false);
    };

    const handleConfirmRevoke = async () => {
        if (pendingRevoke === null || pendingRevoke.grant_id === null) return;
        const saved = await onRevoke(pendingRevoke.grant_id, pendingRevoke.full_name);
        if (saved) setPendingRevoke(null);
    };

    return (
        <div
            data-slot="access-list"
            data-policy-open={policyOpen}
            aria-disabled={policyOpen}
            inert={policyOpen}
            className={cn(
                "overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm",
                policyOpen && "pointer-events-none opacity-50 select-none",
            )}
        >
            <div className="flex flex-col gap-3 border-b bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium">Department members</h2>
                    <p className="text-xs text-muted-foreground">
                                Everyone in your department and whether they have Edit access
                                — including assigning people, setting status and priority, and changing
                                dates and custom fields.
                            </p>
                            {policyOpen ? (
                                <p className="text-xs text-muted-foreground">
                                    Every member already has Edit access, so there is nothing to grant
                                    individually. Turn the switch off to grant it member by member.
                                </p>
                            ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onRefresh}
                        disabled={isLoading || isSubmitting}
                        className="min-h-11 md:min-h-0"
                    >
                        <RotateCcw className="size-4" aria-hidden="true" />
                        Refresh
                    </Button>

                    {canGrant ? (
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => setIsGrantDialogOpen(true)}
                            disabled={isSubmitting || candidates.length === 0}
                            title={
                                candidates.length === 0
                            ? "Every member already has Edit access"
                            : "Grant Edit access to a member"
                            }
                            className="min-h-11 md:min-h-0"
                        >
                            <UserPlus className="size-4" aria-hidden="true" />
                            Grant access
                        </Button>
                    ) : null}
                </div>
            </div>

            {showError ? (
                <div className="px-4 py-3">
                    <Alert variant="destructive">
                        <AlertTriangle className="size-4" aria-hidden="true" />
                        <AlertTitle>Access error</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                </div>
            ) : null}

            {/* Narrow viewports: the same roster, fields and action as a stacked card list. */}
            <div className="xl:hidden">
                {isLoading ? (
                    <ul data-slot="access-list-card-skeleton" className="divide-y divide-border">
                        {Array.from({ length: 4 }).map((_, row) => (
                            <li key={`grant-card-skeleton-${row}`} className="space-y-2 p-4">
                                <div className="flex items-center gap-3">
                                    <Skeleton className="size-8 shrink-0 rounded-full" />
                                    <div className="min-w-0 space-y-1.5">
                                        <Skeleton className="h-4 w-36" />
                                        <Skeleton className="h-3 w-48" />
                                    </div>
                                </div>
                                <Skeleton className="h-5 w-24" />
                                <Skeleton className="h-4 w-28" />
                            </li>
                        ))}
                    </ul>
                ) : showError ? (
                    <div className="flex h-32 items-center justify-center p-6 text-center">
                        <p className="text-sm text-muted-foreground">
                            The member list could not be loaded.
                        </p>
                    </div>
                ) : isEmpty ? (
                    <div className="flex h-48 flex-col items-center justify-center gap-2 p-6 text-center">
                        <Users className="size-8 text-muted-foreground/50" aria-hidden="true" />
                        <p className="text-sm text-muted-foreground">No department members found.</p>
                        <p className="text-xs text-muted-foreground">
                            Members appear here once they are assigned to your department.
                        </p>
                    </div>
                ) : (
                    <ul data-slot="access-list-card" className="divide-y divide-border">
                        {items.map((member) => (
                            <li key={member.user_id} className="space-y-2 p-4">
                                <div className="flex items-start gap-3">
                                    <Avatar
                                        size="sm"
                                        role="img"
                                        aria-label={member.full_name}
                                        className="shrink-0"
                                    >
                                        <AvatarFallback>{initialsOf(member.full_name)}</AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0 flex-1">
                                        <p className="break-words text-sm font-medium">
                                            {member.full_name}
                                        </p>
                                        {member.user_email ? (
                                            <p className="break-words text-xs text-muted-foreground">
                                                {member.user_email}
                                            </p>
                                        ) : null}
                                    </div>
                                    <AccessStateBadge hasEdit={member.is_granted || policyOpen} />
                                </div>

                                <p className="break-words text-xs text-muted-foreground">
                                    Granted by {provenanceLabel(member, memberNameById)}
                                </p>

                                {canGrant && member.is_granted && member.grant_id !== null ? (
                                    <RevokeButton
                                        member={member}
                                        isSubmitting={isSubmitting}
                                        onRevoke={setPendingRevoke}
                                        className="min-h-11"
                                    />
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="hidden xl:block">
                <Table className="min-w-[640px]">
                    <TableHeader className="bg-muted/30">
                        <TableRow>
                            <TableHead scope="col" className="min-w-[260px]">
                                Member
                            </TableHead>
                            <TableHead scope="col" className="w-[170px]">
                                Access
                            </TableHead>
                            <TableHead scope="col" className="w-[200px]">
                                Granted by
                            </TableHead>
                            {canGrant ? (
                                <TableHead scope="col" className="w-[130px] text-right">
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            ) : null}
                        </TableRow>
                    </TableHeader>

                    <TableBody>
                        {isLoading ? (
                            Array.from({ length: 4 }).map((_, row) => (
                                <TableRow key={`grant-skeleton-${row}`} data-slot="access-list-skeleton">
                                    {/* One cell per entry in `BASE_COLUMN_COUNT`, plus the gated actions cell. */}
                                    <TableCell>
                                        <div className="flex items-center gap-3">
                                            <Skeleton className="size-8 shrink-0 rounded-full" />
                                            <div className="min-w-0 space-y-1.5">
                                                <Skeleton className="h-4 w-36" />
                                                <Skeleton className="h-3 w-48" />
                                            </div>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Skeleton className="h-5 w-24" />
                                    </TableCell>
                                    <TableCell>
                                        <Skeleton className="h-4 w-28" />
                                    </TableCell>
                                    {canGrant ? (
                                        <TableCell className="text-right">
                                            <Skeleton className="ml-auto h-5 w-16" />
                                        </TableCell>
                                    ) : null}
                                </TableRow>
                            ))
                        ) : showError ? (
                            <TableRow data-slot="access-list-error">
                                <TableCell colSpan={columnCount} className="h-32 text-center">
                                    <p className="text-sm text-muted-foreground">
                                        The member list could not be loaded.
                                    </p>
                                </TableCell>
                            </TableRow>
                        ) : isEmpty ? (
                            <TableRow data-slot="access-list-empty">
                                <TableCell colSpan={columnCount} className="h-48 text-center">
                                    <div className="flex flex-col items-center justify-center gap-2">
                                        <Users
                                            className="size-8 text-muted-foreground/50"
                                            aria-hidden="true"
                                        />
                                        <p className="text-sm text-muted-foreground">
                                            No department members found.
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Members appear here once they are assigned to your
                                            department.
                                        </p>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : (
                            items.map((member) => (
                                <TableRow key={member.user_id} data-slot="access-list-row">
                                    <TableCell>
                                        <div className="flex items-center gap-3">
                                            <Avatar
                                                size="sm"
                                                role="img"
                                                aria-label={member.full_name}
                                                className="shrink-0"
                                            >
                                                <AvatarFallback>
                                                    {initialsOf(member.full_name)}
                                                </AvatarFallback>
                                            </Avatar>
                                            <div className="min-w-0">
                                                <p
                                                    className="max-w-[220px] truncate text-sm font-medium"
                                                    title={member.full_name}
                                                >
                                                    {member.full_name}
                                                </p>
                                                {member.user_email ? (
                                                    <p
                                                        className="max-w-[220px] truncate text-xs text-muted-foreground"
                                                        title={member.user_email}
                                                    >
                                                        {member.user_email}
                                                    </p>
                                                ) : null}
                                            </div>
                                        </div>
                                    </TableCell>

                                    <TableCell>
                                        <AccessStateBadge hasEdit={member.is_granted || policyOpen} />
                                    </TableCell>

                                    <TableCell>
                                        <span
                                            className={cn(
                                                "block max-w-[180px] truncate text-sm",
                                                !member.is_granted && "text-muted-foreground",
                                            )}
                                            title={provenanceLabel(member, memberNameById)}
                                        >
                                            {provenanceLabel(member, memberNameById)}
                                        </span>
                                    </TableCell>

                                    {canGrant ? (
                                        <TableCell className="text-right">
                                            {member.is_granted && member.grant_id !== null ? (
                                                <RevokeButton
                                                    member={member}
                                                    isSubmitting={isSubmitting}
                                                    onRevoke={setPendingRevoke}
                                                />
                                            ) : (
                                                <span className="text-sm text-muted-foreground">
                                                    —
                                                </span>
                                            )}
                                        </TableCell>
                                    ) : null}
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>

            {canGrant ? (
                <AccessGrantDialog
                    open={isGrantDialogOpen}
                    onOpenChange={setIsGrantDialogOpen}
                    candidates={candidates}
                    isSubmitting={isSubmitting}
                    onSubmit={handleGrantSubmit}
                />
            ) : null}

            <AlertDialog
                open={pendingRevoke !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingRevoke(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Revoke Edit access?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {pendingRevoke === null
                                ? ""
                                : `${pendingRevoke.full_name} will lose Edit access to this department's tasks — including assigning people, setting status and priority, and changing dates and custom fields. Everything else stays, and they can still work on tasks they created. This can be granted again later.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={isSubmitting}
                            onClick={() => {
                                void handleConfirmRevoke();
                            }}
                        >
                            Revoke access
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

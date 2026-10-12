"use client";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

/**
 * The department's access policy: whether every member HAS Edit access, or only the head and the
 * members individually granted it.
 *
 * The head gets the switch. Everyone else gets the same card READ-ONLY, because the state is
 * information the whole department needs — it decides whether granting access is even meaningful —
 * while only the CHANGE is head-only, which the server's PATCH enforces regardless of what is
 * rendered here.
 *
 * The component owns no state and performs no fetch: the value comes from the route payload and
 * `onChange` runs the mutation, which refetches on success. While a mutation is in flight the switch
 * is disabled, so a value cannot be flipped twice before the server answers.
 */
export interface AccessPolicyCardProps {
    /** Server-resolved policy, ON by default for a department with no setting row. */
    allowAllMembersGrant: boolean;
    /** True while any mutation is in flight (the page's single `isSubmitting` flag). */
    isSaving: boolean;
    /** Runs the policy mutation; the page refetches on success, so no local state is kept here. */
    onChange: (enabled: boolean) => void;
    /** False for a non-head: the policy renders as a read-only indicator, with no switch at all. */
    canManage: boolean;
}

export function AccessPolicyCard({
    allowAllMembersGrant,
    isSaving,
    onChange,
    canManage,
}: AccessPolicyCardProps) {
    return (
        <div
            data-slot="access-policy"
            className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm"
        >
            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0 space-y-1">
                    {canManage ? (
                        <label
                            htmlFor="allow-all-members-grant"
                            className="block cursor-pointer text-sm font-medium"
                        >
                            Allow all members Edit access
                        </label>
                    ) : (
                        <p className="text-sm font-medium">Edit access</p>
                    )}
                    <p
                        id={canManage ? "allow-all-members-grant-description" : undefined}
                        className="text-xs text-muted-foreground"
                    >
                        {allowAllMembersGrant
                            ? "Every member can edit tasks."
                            : "Only the head and granted members can edit tasks."}
                    </p>
                </div>

                {canManage ? (
                    <Switch
                        id="allow-all-members-grant"
                        checked={allowAllMembersGrant}
                        onCheckedChange={onChange}
                        disabled={isSaving}
                        aria-describedby="allow-all-members-grant-description"
                        className="shrink-0 sm:mt-0.5"
                    />
                ) : (
                    <Badge variant="secondary" className="shrink-0">
                        {allowAllMembersGrant ? "All members" : "Head + granted"}
                    </Badge>
                )}
            </div>
        </div>
    );
}

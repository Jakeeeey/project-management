"use client";

import { Switch } from "@/components/ui/switch";

/**
 * The department's assignment-grant policy control.
 *
 * One decision, one switch: whether every member of the department may grant and revoke assigner
 * rights, or only the head. It is rendered ONLY for the head — `AssignmentGrantsPage` mounts it on
 * the server-resolved `capabilities.canManageDepartmentSetting`, so a member who may grant while the
 * policy is ON still never sees the control, and the server's PATCH refuses them regardless.
 *
 * The component owns no state and performs no fetch: the checked value comes from the route payload
 * and `onChange` runs the mutation, which refetches the page's data on success. While a mutation is
 * in flight the switch is disabled, so a value cannot be flipped twice before the server answers.
 */
export interface GrantPolicyCardProps {
    /** Server-resolved policy, ON by default for a department with no setting row. */
    allowAllMembersGrant: boolean;
    /** True while any mutation is in flight (the page's single `isSubmitting` flag). */
    isSaving: boolean;
    /** Runs the policy mutation; the page refetches on success, so no local state is kept here. */
    onChange: (enabled: boolean) => void;
}

export function GrantPolicyCard({ allowAllMembersGrant, isSaving, onChange }: GrantPolicyCardProps) {
    return (
        <div
            data-slot="grant-policy"
            className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm"
        >
            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0 space-y-1">
                    <label
                        htmlFor="allow-all-members-grant"
                        className="block cursor-pointer text-sm font-medium"
                    >
                        Allow all members to grant assigner rights
                    </label>
                    <p
                        id="allow-all-members-grant-description"
                        className="text-xs text-muted-foreground"
                    >
                        When on, every member of your department can grant and revoke assigner rights.
                        When off, only the department head can. Assigning tasks still needs headship or
                        assigner rights either way.
                    </p>
                </div>

                <Switch
                    id="allow-all-members-grant"
                    checked={allowAllMembersGrant}
                    onCheckedChange={onChange}
                    disabled={isSaving}
                    aria-describedby="allow-all-members-grant-description"
                    className="shrink-0 sm:mt-0.5"
                />
            </div>
        </div>
    );
}

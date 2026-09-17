"use client";

import { Switch } from "@/components/ui/switch";

/**
 * The department's access policy control.
 *
 * One decision, one switch: whether every member of the department HAS Edit access, or only the head
 * and the members individually granted it. It is rendered ONLY for the head — `AccessPage` mounts it
 * on the server-resolved `capabilities.canManageDepartmentSetting`, so a member who gains access from
 * this policy still never sees the control, and the server's PATCH refuses them regardless.
 *
 * Because ON grants everyone access outright, the per-member grant control below it becomes moot;
 * `AccessPage` mutes that card while this is on rather than pretending it still does something.
 *
 * The component owns no state and performs no fetch: the checked value comes from the route payload
 * and `onChange` runs the mutation, which refetches the page's data on success. While a mutation is
 * in flight the switch is disabled, so a value cannot be flipped twice before the server answers.
 */
export interface AccessPolicyCardProps {
    /** Server-resolved policy, ON by default for a department with no setting row. */
    allowAllMembersGrant: boolean;
    /** True while any mutation is in flight (the page's single `isSubmitting` flag). */
    isSaving: boolean;
    /** Runs the policy mutation; the page refetches on success, so no local state is kept here. */
    onChange: (enabled: boolean) => void;
}

export function AccessPolicyCard({ allowAllMembersGrant, isSaving, onChange }: AccessPolicyCardProps) {
    return (
        <div
            data-slot="access-policy"
            className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm"
        >
            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0 space-y-1">
                    <label
                        htmlFor="allow-all-members-grant"
                        className="block cursor-pointer text-sm font-medium"
                    >
                        Allow all members Edit access
                    </label>
                    <p
                        id="allow-all-members-grant-description"
                        className="text-xs text-muted-foreground"
                    >
                        On: every member can edit tasks. Off: only you and the members you grant. A
                        task&apos;s creator can always edit it.
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

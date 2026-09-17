"use client";

import { useAccess } from "../hooks/useAccess";
import { AccessList } from "./AccessList";
import { AccessPolicyCard } from "./AccessPolicyCard";

/**
 * The Access client orchestrator.
 *
 * It owns exactly two gates, both read from the route's server-resolved `capabilities` (never
 * derived here): `canGrant` decides whether the grant/revoke controls exist at all, and
 * `canManageDepartmentSetting` decides whether the policy switch is mounted. A department whose
 * policy is ON tells every member `canGrant: true` while still telling them
 * `canManageDepartmentSetting: false`, so members can hand out rights but can never change the
 * policy that lets them — and the switch is not rendered into the DOM for them at all.
 *
 * The switch is held back until `setting` has loaded, so it never renders a policy the server has
 * not confirmed; the roster is handed straight to `AccessList`.
 */
export function AccessPage() {
    const {
        items,
        isLoading,
        isSubmitting,
        error,
        capabilities,
        setting,
        memberNameById,
        refresh,
        grant,
        revoke,
        setAllowAllMembersGrant,
    } = useAccess();

    const canGrant = capabilities?.canGrant === true;
    const canManageSetting = capabilities?.canManageDepartmentSetting === true;
    /** The "Allow all members Edit access" policy — while ON, per-member granting is moot. */
    const policyOpen = setting?.allow_all_members_grant === true;

    return (
        <section
            data-slot="access-page"
            className="mx-auto w-full max-w-5xl scroll-pt-16 space-y-4 px-4 py-6 md:scroll-pt-20"
        >
            <div className="space-y-1">
                <h1 className="text-lg font-semibold tracking-tight">Access</h1>
                <p className="text-sm text-muted-foreground">
                    Who may edit this department&apos;s tasks. Edit access covers everything a task edit
                    can change — assigning people, setting status and priority, and changing dates and
                    custom fields. Your department decides whether the head alone or every member can
                    grant Edit access.
                </p>
            </div>

            {canManageSetting && setting !== null ? (
                <AccessPolicyCard
                    allowAllMembersGrant={setting.allow_all_members_grant}
                    isSaving={isSubmitting}
                    onChange={(enabled) => {
                        void setAllowAllMembersGrant(enabled);
                    }}
                />
            ) : null}

            <AccessList
                items={items}
                isLoading={isLoading}
                isSubmitting={isSubmitting}
                error={error}
                canGrant={canGrant}
                policyOpen={policyOpen}
                memberNameById={memberNameById}
                onGrant={grant}
                onRevoke={revoke}
                onRefresh={() => {
                    void refresh();
                }}
            />
        </section>
    );
}

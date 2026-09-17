"use client";

import { useAssignmentGrants } from "../hooks/useAssignmentGrants";
import { GrantList } from "./GrantList";
import { GrantPolicyCard } from "./GrantPolicyCard";

/**
 * The Assignment Grants client orchestrator.
 *
 * It owns exactly two gates, both read from the route's server-resolved `capabilities` (never
 * derived here): `canGrant` decides whether the grant/revoke controls exist at all, and
 * `canManageDepartmentSetting` decides whether the policy switch is mounted. A department whose
 * policy is ON tells every member `canGrant: true` while still telling them
 * `canManageDepartmentSetting: false`, so members can hand out rights but can never change the
 * policy that lets them — and the switch is not rendered into the DOM for them at all.
 *
 * The switch is held back until `setting` has loaded, so it never renders a policy the server has
 * not confirmed; the roster is handed straight to `GrantList`.
 */
export function AssignmentGrantsPage() {
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
    } = useAssignmentGrants();

    const canGrant = capabilities?.canGrant === true;
    const canManageSetting = capabilities?.canManageDepartmentSetting === true;

    return (
        <section
            data-slot="access-page"
            className="mx-auto w-full max-w-5xl scroll-pt-16 space-y-4 px-4 py-6 md:scroll-pt-20"
        >
            <div className="space-y-1">
                <h1 className="text-lg font-semibold tracking-tight">Assignment grants</h1>
                <p className="text-sm text-muted-foreground">
                    A member with assigner rights can hand out tasks and edit this department&apos;s
                    status and priority catalog. Your department decides whether the head alone or
                    every member can grant that right.
                </p>
            </div>

            {canManageSetting && setting !== null ? (
                <GrantPolicyCard
                    allowAllMembersGrant={setting.allow_all_members_grant}
                    isSaving={isSubmitting}
                    onChange={(enabled) => {
                        void setAllowAllMembersGrant(enabled);
                    }}
                />
            ) : null}

            <GrantList
                items={items}
                isLoading={isLoading}
                isSubmitting={isSubmitting}
                error={error}
                canGrant={canGrant}
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

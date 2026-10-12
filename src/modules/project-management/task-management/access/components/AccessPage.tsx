"use client";

import { useAccess } from "../hooks/useAccess";
import { AccessList } from "./AccessList";
import { AccessPolicyCard } from "./AccessPolicyCard";

/**
 * The Access client orchestrator.
 *
 * It owns exactly two gates, both read from the route's server-resolved `capabilities` (never
 * derived here): `canGrant` decides whether the grant/revoke controls exist at all, and
 * `canManageDepartmentSetting` decides whether the policy card is INTERACTIVE. The policy itself is
 * shown to everyone, because whether the whole department already has Edit access decides whether
 * granting is meaningful at all; only the switch is head-only, and the server's PATCH refuses
 * everyone else regardless.
 *
 * The card is held back until `setting` has loaded, so it never renders a policy the server has not
 * confirmed; the roster is handed straight to `AccessList`.
 */
export function AccessPage() {
    const {
        items,
        page,
        pageSize,
        total,
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
        setPage,
        setPageSize,
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
                <p className="text-sm text-muted-foreground">Who can edit this department&apos;s tasks.</p>
            </div>

            {setting !== null ? (
                <AccessPolicyCard
                    allowAllMembersGrant={setting.allow_all_members_grant}
                    isSaving={isSubmitting}
                    onChange={(enabled) => {
                        void setAllowAllMembersGrant(enabled);
                    }}
                    canManage={canManageSetting}
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
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
            />
        </section>
    );
}

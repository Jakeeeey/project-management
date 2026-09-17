"use client";

import { useAssignmentGrants } from "../hooks/useAssignmentGrants";
import { GrantList } from "./GrantList";

/**
 * The Assignment Grants client orchestrator.
 *
 * It owns exactly one decision — whether the actor may grant, read from the route's
 * `capabilities.canGrant` (never derived here) — and hands the roster, the loading/error state and
 * the two mutations straight to `GrantList`. A non-head's capability payload says `canGrant: false`,
 * so the grant control is never mounted.
 */
export function AssignmentGrantsPage() {
    const {
        items,
        isLoading,
        isSubmitting,
        error,
        capabilities,
        memberNameById,
        refresh,
        grant,
        revoke,
    } = useAssignmentGrants();

    const canGrant = capabilities?.canGrant === true;

    return (
        <section
            data-slot="assignment-grants-page"
            className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6"
        >
            <div className="space-y-1">
                <h1 className="text-lg font-semibold tracking-tight">Assignment grants</h1>
                <p className="text-sm text-muted-foreground">
                    A member with assigner rights can hand out tasks and edit this department&apos;s
                    status and priority catalog. Only the department head can grant or revoke that
                    right.
                </p>
            </div>

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

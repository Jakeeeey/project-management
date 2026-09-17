"use client";

import Link from "next/link";
import { Plus, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Capabilities } from "@/modules/project-management/types/capabilities";

/**
 * The tasks page-level actions, rendered beside the page title rather than inside the filter bar.
 *
 * Splitting them out is what lets the filter bar stay one readable row of list controls: the
 * configuration destination and the primary "New task" action are page chrome, not filtering. Every
 * affordance is gated on the SERVER-resolved `capabilities` object — a capability that is `false`
 * (or not yet loaded) leaves the control out of the DOM entirely. No client-side role check, no
 * session inspection and no user-id comparison decides what is shown.
 *
 * Labels are always rendered, at every width: the settings destination is this page's only route to
 * the status, priority and custom-column configuration, so collapsing it to a bare icon would make
 * it unidentifiable.
 */

export interface TasksHeaderActionsProps {
    /** Server-resolved capabilities; the ONLY thing the action gates read. */
    readonly capabilities: Capabilities | null;
    readonly onCreateTask: () => void;
}

export function TasksHeaderActions({ capabilities, onCreateTask }: TasksHeaderActionsProps) {
    const canCreate = capabilities?.canCreate === true;
    const canConfigure = capabilities?.canConfigure === true;

    if (!canCreate && !canConfigure) return null;

    return (
        <div
            data-slot="tasks-header-actions"
            className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap"
        >
            {canConfigure ? (
                <Button asChild variant="outline">
                    <Link href="/project-management/task-management/configure">
                        <Settings2 className="size-4" aria-hidden="true" />
                        Configure
                    </Link>
                </Button>
            ) : null}

            {canCreate ? (
                <Button type="button" onClick={onCreateTask}>
                    <Plus className="size-4" aria-hidden="true" />
                    New task
                </Button>
            ) : null}
        </div>
    );
}
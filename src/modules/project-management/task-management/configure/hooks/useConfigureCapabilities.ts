"use client";

import { useEffect, useState } from "react";

import { CapabilitiesSchema } from "../types/capabilities";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The actor's server-resolved `canConfigure`, or `null` until the first successful load.
 *
 * Read from the same configure GET the catalog section uses; the row payload is discarded, only
 * the capabilities envelope is parsed. `null` means "unknown", never "denied", so callers must
 * treat it as enabled until the server answers.
 */
export function useConfigureCapabilities(): boolean | null {
    const [canConfigure, setCanConfigure] = useState<boolean | null>(null);

    useEffect(() => {
        let cancelled = false;

        void (async (): Promise<void> => {
            try {
                const res = await fetch("/api/project-management/task-management/configure", {
                    cache: "no-store",
                });
                const payload: unknown = await res.json().catch(() => null);
                if (!res.ok || !isRecord(payload)) return;
                const parsed = CapabilitiesSchema.safeParse(payload.capabilities);
                if (!cancelled && parsed.success) setCanConfigure(parsed.data.canConfigure);
            } catch {
                // Unknown stays unknown: the shell leaves every tab enabled.
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    return canConfigure;
}

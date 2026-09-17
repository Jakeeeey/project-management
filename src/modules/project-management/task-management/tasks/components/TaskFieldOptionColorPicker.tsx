"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";

/** A valid 6-digit hex the native colour input can render before the user picks their own. */
const FALLBACK_HEX = "#64748b";

export interface TaskFieldOptionColorPickerProps {
    /** The choice being coloured; names the controls only. */
    readonly optionLabel: string;
    /** The column the choice belongs to; names the controls only. */
    readonly fieldLabel: string;
    readonly color: string | null;
    /** True while a mutation is in flight; never tied to the column's `is_enabled`. */
    readonly disabled: boolean;
    readonly onChange: (color: string | null) => void;
}

/**
 * The colour control for one choice: a native picker next to a hex text input.
 *
 * The native picker commits on every `change` because each event is a finished pick, but the text
 * field keeps a local draft and commits on blur — a hex is typed character by character and must not
 * become one refetch per keystroke. The draft is seeded from the prop, not synced to it: the call
 * site keys this component on the stored colour, so a refetch remounts it with the authoritative value.
 */
export function TaskFieldOptionColorPicker({
    optionLabel,
    fieldLabel,
    color,
    disabled,
    onChange,
}: TaskFieldOptionColorPickerProps) {
    const [draft, setDraft] = useState(color ?? "");

    const commitDraft = () => {
        const next = draft.trim();
        if (next === (color ?? "")) return;
        onChange(next === "" ? null : next);
    };

    const accessibleName = `Colour for the choice ${optionLabel} of ${fieldLabel}`;

    return (
        <div className="flex items-center gap-2">
            <input
                type="color"
                aria-label={accessibleName}
                title={accessibleName}
                disabled={disabled}
                className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
                value={color ?? FALLBACK_HEX}
                onChange={(event) => onChange(event.target.value)}
            />
            <Input
                aria-label={`${accessibleName} hex value`}
                title={`${accessibleName} hex value`}
                placeholder="#16a34a"
                autoComplete="off"
                disabled={disabled}
                className="w-28 font-mono"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitDraft}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
            />
        </div>
    );
}

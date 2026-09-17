"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";

import "react-quill-new/dist/quill.snow.css";

import { descriptionToStorage } from "./description-html";

/**
 * The task description's rich-text control.
 *
 * ## Why this is its own component
 *
 * `TaskFormDialog` is a large form, and Quill brings two concerns the rest of it does not need to
 * know about: a client-only dynamic import (Quill touches `document` at module scope, so it must
 * never be evaluated during the server pass) and the "an empty document is not an empty string"
 * normalisation that lives in `./description-html`. Keeping both here means the form imports one
 * control and stays readable.
 *
 * ## Client-only loading
 *
 * `react-quill-new` (the maintained `react-quill` fork, React 19 compatible) ships an ES module with
 * no SSR guard. It is loaded through `next/dynamic` with `ssr: false`, exactly as `GanttView` loads
 * the Gantt library: the module body and the render both stay out of the server pass, and the
 * browser gets a reserved-space fallback while the chunk arrives. The Quill stylesheet is imported
 * statically — CSS is extracted by the bundler and never executed, so it carries no DOM risk.
 *
 * ## Label association
 *
 * `FormControl` clones this component and injects `id` / `aria-describedby` / `aria-invalid` (the
 * same values it would put on a native `<input>`). Quill is not a native input, so the `id` is
 * forwarded to Quill's own root element — without that, `<FormLabel htmlFor>` would point at
 * nothing. Because a contenteditable is labelled by ARIA rather than by `for`, the effect below also
 * marks the editing area as a multiline textbox and copies the injected description/invalid state
 * onto it. The effect is mutation-observed because the editor mounts asynchronously, after the
 * dynamic chunk resolves.
 *
 * ## Layout
 *
 * The dialog body is its own scroll region. The editing area gets a bounded min/max height (see
 * {@link EDITOR_CSS}) so a long description scrolls inside the editor instead of growing the dialog
 * and pushing the footer off-screen.
 */

/** Toolbar contents: headings, the usual inline marks, lists, quotes/code, links, and a clear-format. */
const EDITOR_MODULES = {
    toolbar: [
        [{ header: [1, 2, 3, false] }],
        ["bold", "italic", "underline", "strike"],
        [{ list: "ordered" }, { list: "bullet" }],
        ["blockquote", "code-block"],
        ["link"],
        ["clean"],
    ],
};

/**
 * Quill-compatible overrides, scoped to this control's wrapper.
 *
 * Quill's snow theme hard-codes `#ccc`/`#444` and a bare `14px` font. These rules remap it onto the
 * app's shadcn tokens (`--input`, `--border`, `--ring`, `--muted`, `--foreground`, `--popover`) so
 * the control matches every other field in the form in both light and dark mode. Specificity is kept
 * at (0,3,0) or lower for icon colours so Quill's own `:hover`/`.ql-active` blue still wins.
 */
const EDITOR_CSS = `
.pm-task-description-editor .ql-toolbar.ql-snow {
    border-color: hsl(var(--input));
    border-top-left-radius: calc(var(--radius) - 2px);
    border-top-right-radius: calc(var(--radius) - 2px);
    background-color: hsl(var(--muted) / 0.3);
}
.pm-task-description-editor .ql-container.ql-snow {
    border-color: hsl(var(--input));
    border-bottom-left-radius: calc(var(--radius) - 2px);
    border-bottom-right-radius: calc(var(--radius) - 2px);
    background-color: hsl(var(--background));
    font-family: inherit;
    font-size: 0.875rem;
}
.pm-task-description-editor .ql-toolbar.ql-snow + .ql-container.ql-snow {
    border-top: 0;
}
.pm-task-description-editor .ql-editor {
    min-height: 120px;
    max-height: 260px;
}
.pm-task-description-editor .ql-editor.ql-blank::before {
    color: hsl(var(--muted-foreground));
    font-style: normal;
}
.pm-task-description-editor .ql-container:focus-within {
    border-color: hsl(var(--ring));
    box-shadow: 0 0 0 3px hsl(var(--ring) / 0.5);
    outline: none;
}
.pm-task-description-editor .ql-snow .ql-stroke {
    stroke: hsl(var(--foreground));
}
.pm-task-description-editor .ql-snow .ql-fill,
.pm-task-description-editor .ql-snow .ql-stroke.ql-fill {
    fill: hsl(var(--foreground));
}
.pm-task-description-editor .ql-snow .ql-picker {
    color: hsl(var(--foreground));
}
.pm-task-description-editor .ql-snow .ql-picker-options {
    background-color: hsl(var(--popover));
    border-color: hsl(var(--border));
}
.pm-task-description-editor .ql-snow .ql-picker-item {
    color: hsl(var(--popover-foreground));
}
.pm-task-description-editor .ql-snow .ql-tooltip {
    z-index: 60;
}
`;

/** The measured height of the editor, reserved while the client-only chunk loads. */
const EDITOR_LOADING_HEIGHT = "min-h-[166px]";

const QuillEditor = dynamic(() => import("react-quill-new").then((module) => module.default), {
    ssr: false,
    loading: () => (
        <div
            data-slot="task-description-editor-loading"
            aria-hidden="true"
            className={`${EDITOR_LOADING_HEIGHT} animate-pulse rounded-md border border-input bg-muted/30`}
        />
    ),
});

export interface TaskDescriptionEditorProps {
    /** The stored HTML, or `null` for "no description". Controlled by the caller. */
    readonly value: string | null;
    /** Receives the next stored value: formatted HTML, or `null` when the document is visually empty. */
    readonly onChange: (next: string | null) => void;
    /**
     * Injected by `FormControl`; placed on Quill's root so `<FormLabel htmlFor>` resolves. Quill is
     * not a native input, so this is the only way the existing label association keeps working.
     */
    readonly id?: string;
    readonly disabled?: boolean;
    readonly placeholder?: string;
    /** Injected by `FormControl`; forwarded onto the editable region (ARIA has no `for`). */
    readonly "aria-describedby"?: string;
    /** Injected by `FormControl` from the field's error state. */
    readonly "aria-invalid"?: boolean;
}

export function TaskDescriptionEditor({
    value,
    onChange,
    id,
    disabled = false,
    placeholder,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid = false,
}: TaskDescriptionEditorProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);

    /**
     * Copies the form's field wiring onto Quill's editable region.
     *
     * The editor does not exist on first render (the dynamic chunk is still loading), so a mutation
     * observer waits for `.ql-editor` to appear and then disconnects — it never watches the editor
     * for the whole session, only until the region is labelled once.
     */
    useEffect(() => {
        const container = containerRef.current;
        if (container === null) return;

        const applyFieldWiring = (): boolean => {
            const editingArea = container.querySelector<HTMLElement>(".ql-editor");
            if (editingArea === null) return false;

            editingArea.setAttribute("role", "textbox");
            editingArea.setAttribute("aria-multiline", "true");
            editingArea.setAttribute("aria-label", "Description");
            if (ariaDescribedBy === undefined) {
                editingArea.removeAttribute("aria-describedby");
            } else {
                editingArea.setAttribute("aria-describedby", ariaDescribedBy);
            }
            if (ariaInvalid) {
                editingArea.setAttribute("aria-invalid", "true");
            } else {
                editingArea.removeAttribute("aria-invalid");
            }

            return true;
        };

        if (applyFieldWiring()) return;

        const observer = new MutationObserver(() => {
            if (applyFieldWiring()) observer.disconnect();
        });
        observer.observe(container, { childList: true, subtree: true });

        return () => observer.disconnect();
    }, [ariaDescribedBy, ariaInvalid]);

    return (
        <div
            ref={containerRef}
            data-slot="task-description-editor"
            className="pm-task-description-editor"
        >
            <style>{EDITOR_CSS}</style>
            <QuillEditor
                id={id}
                value={value ?? ""}
                onChange={(html) => onChange(descriptionToStorage(html))}
                readOnly={disabled}
                placeholder={placeholder}
                modules={EDITOR_MODULES}
                /*
                 * Raw `editor.root.innerHTML` rather than Quill's semantic-HTML pass. The semantic
                 * pass escapes every space as `&nbsp;` for round-trip fidelity, so a stored
                 * "review the schema" would become "review&nbsp;the&nbsp;schema" — which still
                 * renders correctly but silently breaks the task list's `Contains` filter (and any
                 * other plain-text substring match) for multi-word descriptions. Raw HTML keeps
                 * ordinary spaces, so those out-of-scope readers behave exactly as before.
                 */
                useSemanticHTML={false}
            />
        </div>
    );
}

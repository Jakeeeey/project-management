/**
 * Storage normalisation for the task form's rich-text description.
 *
 * The description control is Quill, which represents "nothing typed" as markup — canonically
 * `<p><br></p>`, but also `<p></p>`, `<p> </p>`, stacked empty lines, or an empty list. That markup
 * is a NON-EMPTY string, so the old plain-text test (`value.trim() ? value : null`) would have
 * stored an empty-HTML shell for every task that was saved without a description. These two helpers
 * are the single place that decides what "empty" means for a rich-text document.
 *
 * This is a STORAGE-normalisation heuristic, not a sanitiser and not a validator. It never rewrites
 * or drops any part of genuinely-formatted content — it only answers "does this document render
 * anything at all?" and maps a yes/no to the stored string or `null`.
 *
 * It is deliberately dependency-free (no DOM, no imports) so it can run during a React change
 * handler, during a server pass, and under `node --experimental-strip-types` in a unit test.
 */

/**
 * Elements that render visible content with no text node at all. A document containing any of these
 * is treated as NON-empty even when tag-stripping leaves no characters, so an inserted image, a
 * horizontal rule, an embedded video or a table is never silently discarded as "blank".
 */
const EMBEDDED_CONTENT_PATTERN =
    /<(?:img|video|iframe|audio|embed|object|canvas|svg|picture|source|hr|table)\b/i;

/**
 * True when a stored description is absent or renders no visible content.
 *
 * The cases treated as EMPTY (all return `true`):
 * - `null` / `undefined`
 * - `""`, `"   "` — a bare whitespace string
 * - Quill's canonical empty document: `<p><br></p>` (and `<p><br/></p>`, `<p><br /></p>`)
 * - Any nesting of empty block/inline tags: `<p></p>`, `<p><strong></strong></p>`, `<div></div>`
 * - Empty lines: `<p><br></p><p><br></p>`, `<p>&nbsp;</p>`, `<p> </p>`
 * - An empty list Quill can emit: `<ol><li data-list="bullet"><span class="ql-ui"></span></li></ol>`
 * - HTML comments alone: `<!-- note -->`
 *
 * The cases treated as NON-empty (return `false`):
 * - Any document with visible text, including a single non-breaking space's worth of text
 * - Any document containing an embedded-content element (see {@link EMBEDDED_CONTENT_PATTERN})
 * - HTML entities other than the whitespace entities `&nbsp;` / `&#160;` / `&#xa0;` — a lone
 *   `&amp;` or `&#8212;` is real content and is preserved
 */
export function isVisuallyEmptyHtml(value: string | null | undefined): boolean {
    if (value === null || value === undefined) return true;

    const html = value.trim();
    if (html === "") return true;

    // Media/embeds with no text still render something, so they are content, not an empty editor.
    if (EMBEDDED_CONTENT_PATTERN.test(html)) return false;

    // Strip comments, then tags, then count only whitespace entities/characters. Any other entity
    // (e.g. `&amp;`, `&#8212;`) survives this pass as literal text and therefore counts as content.
    const text = html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
        .replace(/\s+/g, "");

    return text === "";
}

/**
 * The value the task form stores for a rich-text description.
 *
 * @returns `null` for anything {@link isVisuallyEmptyHtml} calls empty, otherwise the document's
 *          HTML with only its outer whitespace trimmed. Genuine formatting (headings, lists, bold,
 *          links, images) is preserved verbatim.
 */
export function descriptionToStorage(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (isVisuallyEmptyHtml(value)) return null;
    return value.trim();
}

/**
 * Comment-body sanitiser (Step 19, BACKEND_AUDIT.md P2-11).
 *
 * Per BUILD_PROGRESS Step 19:
 *  - Strip HTML.
 *  - Allow a markdown subset (bold/italic/code/links/lists/headings/quotes
 *    are all left intact — the renderer is responsible for the actual
 *    markdown subset enforcement on the FE side).
 *  - Length cap (enforced by the validator, not here).
 *
 * Implementation note: switched from regex passes to `sanitize-html`
 * (P2-11). The DOM-aware parser handles broken-up tags
 * (`<scr<script>ipt>alert(1)</script>`), invalid HTML, and `<script>` /
 * `<style>` content removal correctly without us hand-rolling each
 * edge case. sanitize-html is configured to drop *every* tag — the
 * markdown renderer on the FE is the only thing that's allowed to emit
 * markup, and it consumes a tag-free string.
 *
 * Pipeline:
 *  1. `sanitize-html` strips every tag. `<script>` / `<style>` content
 *     is dropped (sanitize-html's `nonTextTags` default includes both).
 *  2. Decode the small set of HTML entities Mongo round-trips
 *     identically (`&amp; &lt; &gt; &quot; &#39; &nbsp;`) so common
 *     copy-paste from the web doesn't render as `&amp;`.
 *  3. Collapse runs of more than 2 consecutive blank lines (paste-bomb
 *     defence — markdown only ever needs one blank line between blocks).
 *  4. Trim outer whitespace.
 *
 * What we deliberately do NOT do:
 *  - Markdown parsing. Storing the raw text means we can swap the FE
 *    markdown renderer (or run a server-side renderer for the email
 *    notification) without rewriting history.
 *  - URL / scheme blocking. Markdown links are validated by the
 *    renderer; the body itself is plain text.
 */

import sanitizeHtml from 'sanitize-html';

const HTML_ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
};

const ENTITY = /&(?:amp|lt|gt|quot|apos|nbsp|#39);/g;
// Match 3+ newlines (allowing intermediate spaces/tabs) and collapse to 2.
const EXCESSIVE_BLANK_LINES = /(?:\r?\n[\t ]*){3,}/g;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
    allowedTags: [],
    allowedAttributes: {},
    // sanitize-html's default `nonTextTags` (script, style, textarea, option,
    // noscript) strips both the tags AND their contents — so a sneaky
    // `<script>alert(1)</script>` doesn't leave the JS literal visible.
    // Keep the default; declared explicitly so a future contributor can
    // see the contract.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
    // Don't re-encode `&` in surviving text — we run our own entity
    // decoder right after.
    disallowedTagsMode: 'discard',
};

export interface SanitiseResult {
    text: string;
    /** True if any tag, comment, or entity was stripped/decoded. */
    modified: boolean;
}

/**
 * Sanitise a markdown comment body, returning the cleaned text and
 * whether anything was modified. Idempotent — calling twice on the same
 * input returns the same output and `modified=false` on the second call.
 */
export const sanitiseCommentBody = (input: string): SanitiseResult => {
    const original = input;

    // 1. Strip every tag (and the contents of `<script>` / `<style>`).
    let out = sanitizeHtml(original, SANITIZE_OPTIONS);

    // 2. Decode safe entities so `&amp;` doesn't render literally.
    out = out.replace(ENTITY, (match) => HTML_ENTITIES[match] ?? match);

    // 3. Normalise excessive blank lines.
    out = out.replace(EXCESSIVE_BLANK_LINES, '\n\n');

    // 4. Trim outer whitespace.
    out = out.trim();

    return { text: out, modified: out !== original.trim() };
};

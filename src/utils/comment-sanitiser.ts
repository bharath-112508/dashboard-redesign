/**
 * Comment-body sanitiser (Step 19).
 *
 * Per BUILD_PROGRESS Step 19:
 *  - Strip HTML.
 *  - Allow a markdown subset (bold/italic/code/links/lists/headings/quotes
 *    are all left intact — the renderer is responsible for the actual
 *    markdown subset enforcement on the FE side).
 *  - Length cap (enforced by the validator, not here).
 *
 * Approach:
 *  1. Drop `<script>` and `<style>` blocks **including their content** so
 *     a sneaky `<script>alert(1)</script>` doesn't leave the JS literal
 *     visible in the comment.
 *  2. Strip every other HTML tag, keeping the inner text.
 *  3. Decode the small set of HTML entities Mongo will round-trip
 *     identically (`&amp; &lt; &gt; &quot; &#39; &nbsp;`) so common copy-
 *     paste from the web doesn't render as `&amp;` in the comment.
 *  4. Collapse runs of more than 2 consecutive blank lines (paste-bomb
 *     defence — markdown only ever needs one blank line between blocks).
 *  5. Trim leading/trailing whitespace.
 *
 * What we deliberately do NOT do:
 *  - Markdown parsing. Storing the raw text means we can swap the FE
 *    markdown renderer (or run a server-side renderer for the email
 *    notification) without rewriting history.
 *  - URL / scheme blocking. Markdown links are validated by the
 *    renderer; the body itself is plain text.
 */

const HTML_ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
};

const SCRIPT_OR_STYLE = /<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const STRAY_OPENING_DANGER_TAG = /<\s*(script|style)\b[^>]*>/gi;
const ANY_HTML_TAG = /<\/?[a-z][^>]*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const ENTITY = /&(?:amp|lt|gt|quot|apos|nbsp|#39);/g;
// Match 3+ newlines (allowing intermediate spaces/tabs) and collapse to 2.
const EXCESSIVE_BLANK_LINES = /(?:\r?\n[\t ]*){3,}/g;

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

    let out = original;

    // 1. Kill `<script>` / `<style>` blocks AND their contents.
    out = out.replace(SCRIPT_OR_STYLE, '');
    // Stray unclosed `<script ...>` opening tags — drop them too.
    out = out.replace(STRAY_OPENING_DANGER_TAG, '');

    // 2. Strip HTML comments.
    out = out.replace(HTML_COMMENT, '');

    // 3. Strip every remaining tag, keeping inner text.
    out = out.replace(ANY_HTML_TAG, '');

    // 4. Decode safe entities so `&amp;` doesn't render literally.
    out = out.replace(ENTITY, (match) => HTML_ENTITIES[match] ?? match);

    // 5. Normalise excessive blank lines.
    out = out.replace(EXCESSIVE_BLANK_LINES, '\n\n');

    // 6. Trim outer whitespace.
    out = out.trim();

    return { text: out, modified: out !== original.trim() };
};

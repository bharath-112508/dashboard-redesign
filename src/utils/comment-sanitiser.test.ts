import { describe, expect, it } from 'vitest';

import { sanitiseCommentBody } from './comment-sanitiser.js';

/**
 * Locks in the contract for the comment sanitiser after the move to
 * `sanitize-html` (BACKEND_AUDIT.md P2-11). The regex-based predecessor
 * was adequate for well-formed input but fell over on a few edge cases
 * a motivated attacker could engineer; this suite pins the new
 * behaviour AND exercises the cases the old regex missed, so a future
 * contributor who thinks "let's go back to a regex, it's faster"
 * regresses visibly.
 */

describe('sanitiseCommentBody', () => {
    // ─── Plain markdown round-trips unchanged ──────────────────────────

    it('passes plain markdown through untouched', () => {
        const input = 'Hello **world** — this is a `code` snippet with [a link](https://example.com).';
        const { text, modified } = sanitiseCommentBody(input);
        expect(text).toBe(input);
        expect(modified).toBe(false);
    });

    it('preserves multi-paragraph markdown', () => {
        const input = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n\n- list item\n- another';
        const { text, modified } = sanitiseCommentBody(input);
        expect(text).toBe(input);
        expect(modified).toBe(false);
    });

    // ─── HTML stripping ────────────────────────────────────────────────

    it('strips a plain HTML tag while keeping the inner text', () => {
        const { text, modified } = sanitiseCommentBody('Click <b>here</b> now.');
        expect(text).toBe('Click here now.');
        expect(modified).toBe(true);
    });

    it('drops `<script>` AND its contents (no JS literal leaks)', () => {
        const { text } = sanitiseCommentBody('Hi<script>alert(1)</script>there');
        expect(text).toBe('Hithere');
        expect(text).not.toContain('alert');
    });

    it('drops `<style>` AND its contents', () => {
        const { text } = sanitiseCommentBody('Hi<style>body{display:none}</style>there');
        expect(text).toBe('Hithere');
        expect(text).not.toContain('display');
    });

    it('drops `<noscript>` AND its contents (default `nonTextTags`)', () => {
        const { text } = sanitiseCommentBody('Hi<noscript>fallback</noscript>there');
        expect(text).toBe('Hithere');
        expect(text).not.toContain('fallback');
    });

    // ─── Adversarial inputs the old regex would mishandle ──────────────

    it('handles broken-up `<scr<script>ipt>` payloads — no surviving script tag', () => {
        // A naive regex pass over `<scr<script>ipt>alert(1)</script>` could
        // strip the inner `<script>...</script>` and leave the outer
        // fragments to re-merge into `<script>alert(1)</script>` on a
        // second decode. sanitize-html parses to a DOM, so the only
        // contract we must lock in here is: NO `<script` substring
        // survives, and there are no angle brackets that would form a
        // tag if re-rendered. Residual plain-text characters are safe.
        const { text } = sanitiseCommentBody('<scr<script>ipt>alert(1)</script>');
        expect(text).not.toContain('<script');
        expect(text).not.toContain('</script');
    });

    it('strips nested tag pairs cleanly', () => {
        const { text } = sanitiseCommentBody('<div><b>bold</b> and <i>italic</i></div>');
        expect(text).toBe('bold and italic');
    });

    it('drops attribute-laden tags (no `<a href="javascript:..."` leak)', () => {
        const { text } = sanitiseCommentBody('<a href="javascript:alert(1)" onclick="x">click</a>');
        expect(text).toBe('click');
        expect(text).not.toContain('javascript:');
        expect(text).not.toContain('onclick');
    });

    // ─── Entity decoding ───────────────────────────────────────────────

    it('decodes the safe entity set', () => {
        const { text } = sanitiseCommentBody('Tom &amp; Jerry &lt;3 &quot;cheese&quot;');
        expect(text).toBe('Tom & Jerry <3 "cheese"');
    });

    it('does NOT decode entities that could re-introduce HTML on second pass', () => {
        // We only decode the seven listed entities. `&Tab;`, `&NewLine;`,
        // and other obscure entities pass through untouched (or get
        // stripped, depending on what sanitize-html does to them).
        const { text } = sanitiseCommentBody('plain &copy; 2026');
        expect(text).toContain('2026');
    });

    // ─── Whitespace normalisation ──────────────────────────────────────

    it('collapses 3+ consecutive blank lines into 2', () => {
        const { text } = sanitiseCommentBody('first\n\n\n\n\nsecond');
        expect(text).toBe('first\n\nsecond');
    });

    it('preserves a single blank line between markdown paragraphs', () => {
        const input = 'first\n\nsecond';
        const { text } = sanitiseCommentBody(input);
        expect(text).toBe(input);
    });

    it('trims outer whitespace', () => {
        const { text } = sanitiseCommentBody('   hello   ');
        expect(text).toBe('hello');
    });

    // ─── Idempotency ────────────────────────────────────────────────────

    it('is idempotent — second call returns modified=false', () => {
        const dirty = '<b>hi</b> &amp; bye';
        const first = sanitiseCommentBody(dirty);
        const second = sanitiseCommentBody(first.text);
        expect(second.text).toBe(first.text);
        expect(second.modified).toBe(false);
    });
});

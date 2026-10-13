import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The mailer module's public surface is three functions, two of which
 * (`sendEmail` / `sendPasswordResetEmail`) are thin transport-routing
 * wrappers. The third — `escapeHtml` — is the XSS defence that
 * `email-templates.ts` and the PDF generator both depend on; that's
 * the one worth pinning thoroughly.
 *
 * What we lock in:
 *   1. `escapeHtml` correctly handles every dangerous HTML char
 *      (`&`, `<`, `>`, `"`, `'`). Order matters: `&` MUST be escaped
 *      first so subsequent escapes don't double-encode.
 *   2. `sendEmail` delegates to the configured transport with the
 *      caller's payload threaded through unchanged.
 *   3. `sendPasswordResetEmail` builds a URL-encoded link, escapes
 *      the user's full_name in the HTML body (XSS defence on
 *      attacker-controlled fields), and tags the dispatch with a
 *      `password_reset` context.
 */

const transportMock = vi.fn();

vi.mock('./email-transports/index.js', () => ({
    getEmailTransport: () => transportMock,
}));

const mailer = await import('./mailer.js');

beforeEach(() => {
    vi.clearAllMocks();
});

describe('escapeHtml', () => {
    it('escapes the five dangerous HTML chars', () => {
        expect(mailer.escapeHtml('&')).toBe('&amp;');
        expect(mailer.escapeHtml('<')).toBe('&lt;');
        expect(mailer.escapeHtml('>')).toBe('&gt;');
        expect(mailer.escapeHtml('"')).toBe('&quot;');
        expect(mailer.escapeHtml("'")).toBe('&#39;');
    });

    it('escapes `&` FIRST so following escapes are not double-encoded', () => {
        // The classic ordering bug: if `<` is escaped before `&`, the
        // resulting `&lt;` gets re-processed as `&amp;lt;`. Pin the
        // ordering by sending a string that exercises it.
        expect(mailer.escapeHtml('<&')).toBe('&lt;&amp;');
    });

    it('handles a realistic XSS payload safely', () => {
        const payload = '<script>alert("xss")</script>';
        const out = mailer.escapeHtml(payload);
        expect(out).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        // Defensive: pin that no <script> tag survives in the output.
        expect(out).not.toContain('<script');
    });

    it('passes plain text through unchanged', () => {
        expect(mailer.escapeHtml('Hello world')).toBe('Hello world');
        expect(mailer.escapeHtml('user@example.com')).toBe('user@example.com');
    });

    it('returns the empty string for an empty input (never throws)', () => {
        expect(mailer.escapeHtml('')).toBe('');
    });
});

describe('sendEmail', () => {
    it('calls the resolved transport with the caller payload', async () => {
        transportMock.mockResolvedValueOnce(undefined);

        await mailer.sendEmail({
            to: 'user@example.com',
            subject: 'Hi',
            html: '<p>Hi</p>',
            text: 'Hi',
            context: 'unit-test',
        });

        expect(transportMock).toHaveBeenCalledTimes(1);
        expect(transportMock).toHaveBeenCalledWith({
            to: 'user@example.com',
            subject: 'Hi',
            html: '<p>Hi</p>',
            text: 'Hi',
            context: 'unit-test',
        });
    });

    it('propagates transport errors (caller decides whether to swallow)', async () => {
        // The dispatcher's never-throw policy lives at the call site
        // (notification-dispatcher.service swallows failures); the
        // raw `sendEmail` MUST surface failures so e.g. the password-
        // reset flow can fall back to a "we'll try again" UX.
        transportMock.mockRejectedValueOnce(new Error('SMTP down'));

        await expect(mailer.sendEmail({ to: 'a@b.c', subject: 's', html: 'h', text: 't' })).rejects.toThrow(
            'SMTP down'
        );
    });
});

describe('sendPasswordResetEmail', () => {
    it('escapes the user-supplied full_name in the HTML body (XSS defence)', async () => {
        // `full_name` is user-controlled. A regression that dropped
        // the escape would let an attacker who registers an account
        // with `<img onerror=...>` as their name land scriptable HTML
        // in any future password-reset email.
        transportMock.mockResolvedValueOnce(undefined);

        await mailer.sendPasswordResetEmail({
            to: 'victim@example.com',
            full_name: '<img onerror="alert(1)">',
            token: 'opaque-token-123',
        });

        const call = transportMock.mock.calls[0]![0] as { html: string; text: string };
        // Raw payload MUST NOT survive; escape MUST be applied.
        expect(call.html).not.toContain('<img onerror');
        expect(call.html).toContain('&lt;img onerror=&quot;alert(1)&quot;&gt;');
    });

    it('URL-encodes the token in the reset link (defence against query-string injection via tokens)', async () => {
        transportMock.mockResolvedValueOnce(undefined);

        await mailer.sendPasswordResetEmail({
            to: 'a@b.c',
            full_name: 'Sam',
            token: 'token with spaces & ampersands',
        });

        const call = transportMock.mock.calls[0]![0] as { html: string };
        // The encoded form of the token must appear; the raw form must NOT.
        expect(call.html).toContain('token%20with%20spaces%20%26%20ampersands');
        expect(call.html).not.toContain('?token=token with');
    });

    it('tags the dispatch with `password_reset` context for log correlation', async () => {
        transportMock.mockResolvedValueOnce(undefined);
        await mailer.sendPasswordResetEmail({ to: 'a@b.c', full_name: 'Sam', token: 'tok' });

        const call = transportMock.mock.calls[0]![0] as { context: string };
        expect(call.context).toBe('password_reset');
    });

    it('emits both html and text bodies (multipart fallback)', async () => {
        // Some clients (and corporate spam filters) prefer the text/plain
        // alternative. The wrapper MUST emit both; a regression that
        // dropped one would fail SPF/DKIM scoring on stricter receivers.
        transportMock.mockResolvedValueOnce(undefined);
        await mailer.sendPasswordResetEmail({ to: 'a@b.c', full_name: 'Sam', token: 'tok' });

        const call = transportMock.mock.calls[0]![0] as { html: string; text: string };
        expect(call.html.length).toBeGreaterThan(0);
        expect(call.text.length).toBeGreaterThan(0);
        // Plain-text body must not have raw HTML markup.
        expect(call.text).not.toContain('<a href');
    });
});

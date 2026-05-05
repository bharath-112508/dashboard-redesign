import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { isSlackConfigured, postSlackMessage, slackContextFrom } from './slack.js';
import type { SlackSettings } from '../models/system-settings.model.js';

/**
 * Unit tests for `utils/slack` (Step 25).
 *
 * Coverage focus:
 *   1. `isSlackConfigured` / `slackContextFrom` — gating: requires
 *      `enabled = true` AND a non-empty bot token.
 *   2. `postSlackMessage` — POSTs to `chat.postMessage` with the
 *      Authorization header + JSON body, returns true on `ok=true`,
 *      false on HTTP non-2xx, false on `ok=false` body, false on
 *      AbortError. Never throws.
 *   3. Truncation — long text is capped to ~3 000 chars.
 */

const fetchMock = vi.fn();

beforeEach(() => {
    vi.resetAllMocks();
    // Replace the global fetch each test so the mock is fresh.
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const makeSettings = (overrides: Partial<SlackSettings> = {}): SlackSettings => ({
    enabled: true,
    channels: {
        leaves: '#leaves',
        attendance: '#attendance',
        projects: '#projects',
        timesheet: '#timesheet',
        general: '#general',
    },
    bot_token: 'xoxb-test-token',
    ...overrides,
});

const okResponse = () =>
    new Response(JSON.stringify({ ok: true, ts: '1234567890.000100' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

const slackErrorResponse = (errorCode: string) =>
    new Response(JSON.stringify({ ok: false, error: errorCode }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

// ─── isSlackConfigured / slackContextFrom ────────────────────────────────

describe('isSlackConfigured', () => {
    it('returns false when settings are null', () => {
        expect(isSlackConfigured(null)).toBe(false);
    });

    it('returns false when enabled is false', () => {
        expect(isSlackConfigured(makeSettings({ enabled: false }))).toBe(false);
    });

    it('returns false when bot_token is null', () => {
        expect(isSlackConfigured(makeSettings({ bot_token: null }))).toBe(false);
    });

    it('returns true when both enabled and bot_token are set', () => {
        expect(isSlackConfigured(makeSettings())).toBe(true);
    });
});

describe('slackContextFrom', () => {
    it('returns null when not configured', () => {
        expect(slackContextFrom(makeSettings({ enabled: false }))).toBeNull();
    });

    it('returns the legacy plaintext bot_token unchanged when the stored value is not encrypted (J1 back-compat)', () => {
        // Pre-J1 deployments still in flight. The bot keeps working until
        // the next PATCH /settings/slack migrates the value to encrypted form.
        const ctx = slackContextFrom(makeSettings({ bot_token: 'xoxb-real' }));
        expect(ctx).toEqual({ enabled: true, botToken: 'xoxb-real' });
    });

    it('J1 — decrypts a stored encrypted bot_token back to plaintext for the Bearer header', async () => {
        // Encrypt the input, store it, and verify slackContextFrom hands the
        // plaintext to consumers (so the Bearer header is correct) — without
        // ever exposing the plaintext in the settings doc.
        const { encryptSecret } = await import('./crypto-aes.js');
        const stored = encryptSecret('xoxb-real-secret');
        // Sanity: the encrypted blob is NOT the plaintext.
        expect(stored).not.toBe('xoxb-real-secret');

        const ctx = slackContextFrom(makeSettings({ bot_token: stored }));
        expect(ctx).toEqual({ enabled: true, botToken: 'xoxb-real-secret' });
    });

    it('J1 — returns null when a value LOOKS encrypted but decryption fails (refuses to ship ciphertext as a Bearer)', () => {
        // Three b64url-shaped segments → matches the envelope shape, but the
        // payload is garbage. The helper must NOT fall back to "treat as
        // plaintext" here, because that would leak the ciphertext shape into
        // the Slack API as the Authorization header.
        const fakeEnvelope = 'AAAA.BBBB.CCCC';
        const ctx = slackContextFrom(makeSettings({ bot_token: fakeEnvelope }));
        expect(ctx).toBeNull();
    });
});

// ─── postSlackMessage ────────────────────────────────────────────────────

describe('postSlackMessage', () => {
    const ctx = { enabled: true, botToken: 'xoxb-test' } as const;

    it('returns true and POSTs the right shape on the happy path', async () => {
        fetchMock.mockResolvedValueOnce(okResponse());
        const ok = await postSlackMessage(ctx, {
            channel: '#leaves',
            text: 'hello',
            context: 'unit-test',
        });
        expect(ok).toBe(true);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://slack.com/api/chat.postMessage');
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer xoxb-test');
        expect(headers['Content-Type']).toContain('application/json');
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ channel: '#leaves', text: 'hello' });
    });

    it('returns false (not throw) on a non-2xx HTTP response', async () => {
        fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
        const ok = await postSlackMessage(ctx, { channel: '#x', text: 'y', context: 'unit-test' });
        expect(ok).toBe(false);
    });

    it('returns false when Slack body has ok=false (logical failure like channel_not_found)', async () => {
        fetchMock.mockResolvedValueOnce(slackErrorResponse('channel_not_found'));
        const ok = await postSlackMessage(ctx, { channel: '#nope', text: 'y', context: 'unit-test' });
        expect(ok).toBe(false);
    });

    it('returns false (not throw) on a fetch network error', async () => {
        fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
        const ok = await postSlackMessage(ctx, { channel: '#x', text: 'y', context: 'unit-test' });
        expect(ok).toBe(false);
    });

    it('truncates text > SLACK_TEXT_MAX (3000 chars) and still posts', async () => {
        fetchMock.mockResolvedValueOnce(okResponse());
        const longText = 'a'.repeat(5_000);
        await postSlackMessage(ctx, { channel: '#x', text: longText, context: 'unit-test' });
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(init.body as string);
        expect(body.text.length).toBeLessThanOrEqual(3_000);
        // Truncation marker tail
        expect(body.text.endsWith('…')).toBe(true);
    });
});

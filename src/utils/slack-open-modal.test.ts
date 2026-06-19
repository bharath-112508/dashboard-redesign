import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSlackModal } from './slack.js';
import type { SlackContext } from './slack.js';

const ctx: SlackContext = { enabled: true, botToken: 'xoxb-test' };

afterEach(() => {
    vi.restoreAllMocks();
});

describe('openSlackModal', () => {
    it('returns true and posts to views.open with trigger_id + view', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), { status: 200 })
        );
        const view = { type: 'modal' };
        const ok = await openSlackModal(ctx, 'trig-123', view);
        expect(ok).toBe(true);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(String(url)).toContain('/views.open');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body).toEqual({ trigger_id: 'trig-123', view });
    });

    it('returns false (never throws) when Slack responds ok:false', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: false, error: 'expired_trigger_id' }), { status: 200 })
        );
        await expect(openSlackModal(ctx, 'trig-123', { type: 'modal' })).resolves.toBe(false);
    });

    it('returns false when fetch throws', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
        await expect(openSlackModal(ctx, 'trig-123', { type: 'modal' })).resolves.toBe(false);
    });
});

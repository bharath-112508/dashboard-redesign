import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSlackModal } from './slack.js';
import type { SlackContext } from './slack.js';

const ctx: SlackContext = { enabled: true, botToken: 'xoxb-test' };

afterEach(() => {
    vi.restoreAllMocks();
});

describe('openSlackModal', () => {
    it('returns true and posts to views.open with trigger_id + view', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        const view = { type: 'modal' };
        const ok = await openSlackModal(ctx, 'trig-123', view, 'log-time-modal-open');
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
        await expect(openSlackModal(ctx, 'trig-123', { type: 'modal' }, 'apply-leave-modal-open')).resolves.toBe(false);
    });

    it('returns false when fetch throws', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
        await expect(openSlackModal(ctx, 'trig-123', { type: 'modal' }, 'apply-leave-modal-open')).resolves.toBe(false);
    });

    it("tags the failure log with the caller's context instead of a hard-coded event name", async () => {
        // Regression: openSlackModal used to hard-code
        // `dispatch_event: 'apply-leave-modal-open'` for every caller. With a
        // second caller (log-time), a log-time views.open failure was
        // mislabelled as an apply-leave failure in the one place an operator
        // would look first. Thread the context through like publishHomeView
        // already does, and prove both distinct contexts reach the log line.
        const loggerModule = await import('./logger.js');
        const warnSpy = vi.spyOn(loggerModule.default, 'warn').mockImplementation(() => loggerModule.default as never);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

        await openSlackModal(ctx, 'trig-123', { type: 'modal' }, 'log-time-modal-open');
        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ dispatch_event: 'log-time-modal-open' }),
            expect.any(String)
        );

        warnSpy.mockClear();
        await openSlackModal(ctx, 'trig-123', { type: 'modal' }, 'apply-leave-modal-open');
        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ dispatch_event: 'apply-leave-modal-open' }),
            expect.any(String)
        );

        warnSpy.mockRestore();
    });
});

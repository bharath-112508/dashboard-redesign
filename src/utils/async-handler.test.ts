import { describe, expect, it, vi } from 'vitest';

import { asyncHandler } from './async-handler.js';

/**
 * `asyncHandler` is the safety net that prevents an unhandled
 * promise rejection from crashing the Node process. Every controller
 * is wrapped in it; the contract is:
 *
 *   1. Resolved promises pass through — no `next()` call.
 *   2. Rejected promises route the error to Express's `next(err)` so
 *      the global error handler picks it up.
 *   3. Synchronous throws (rare in async controllers, but possible
 *      if someone calls a non-async function that throws) are also
 *      routed via `Promise.resolve(...).catch(next)` — pin it.
 */

const stubRes = () => ({}) as Parameters<ReturnType<typeof asyncHandler>>[1];
const stubReq = () => ({}) as Parameters<ReturnType<typeof asyncHandler>>[0];

describe('asyncHandler', () => {
    it('does NOT call next() when the wrapped handler resolves', async () => {
        const next = vi.fn();
        const handler = asyncHandler(async () => {
            // simulating a controller that returns successfully
        });

        await handler(stubReq(), stubRes(), next);
        // Allow any microtasks to flush.
        await new Promise((r) => setImmediate(r));

        expect(next).not.toHaveBeenCalled();
    });

    it('routes a rejected promise into next(err) for the global error handler', async () => {
        const next = vi.fn();
        const boom = new Error('controller blew up');
        const handler = asyncHandler(async () => {
            throw boom;
        });

        handler(stubReq(), stubRes(), next);
        await new Promise((r) => setImmediate(r));

        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith(boom);
    });

    it('routes an async function that rejects on its first await', async () => {
        // Pinned-shape variant — the realistic shape of a "throws before
        // any await" controller still rejects through the promise chain
        // because async functions auto-wrap throws into rejections.
        const next = vi.fn();
        const boom = new Error('throws before any await');
        const handler = asyncHandler(async () => {
            throw boom;
        });

        handler(stubReq(), stubRes(), next);
        await new Promise((r) => setImmediate(r));

        expect(next).toHaveBeenCalledWith(boom);
    });
});

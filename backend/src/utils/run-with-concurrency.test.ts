import { describe, expect, it } from 'vitest';

import { runWithConcurrency } from './run-with-concurrency.js';

/**
 * Pins the contract for the bounded-concurrency helper (BACKEND_AUDIT.md
 * R11). The notification dispatcher relies on it to never have more
 * than N parallel sends in flight against ACS / Mailjet.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runWithConcurrency', () => {
    it('returns results in input order regardless of completion order', async () => {
        const items = [3, 1, 2]; // ms delays
        const result = await runWithConcurrency(items, 3, async (ms, i) => {
            await sleep(ms);
            return `item-${i}`;
        });
        expect(result).toEqual(['item-0', 'item-1', 'item-2']);
    });

    it('never exceeds the concurrency limit', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const items = Array.from({ length: 20 }, (_, i) => i);

        await runWithConcurrency(items, 5, async () => {
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await sleep(10);
            inFlight -= 1;
        });

        expect(maxInFlight).toBeLessThanOrEqual(5);
    });

    it('continues past a single failure (best-effort) and rejects with the FIRST error', async () => {
        const items = [0, 1, 2, 3, 4];
        const calls: number[] = [];

        await expect(
            runWithConcurrency(items, 2, async (i) => {
                calls.push(i);
                if (i === 1) throw new Error('boom-1');
                if (i === 3) throw new Error('boom-3');
                return i * 2;
            })
        ).rejects.toThrow('boom-1');

        // All five items were attempted despite two failures — siblings
        // shouldn't be cancelled when one rejects.
        expect(calls.sort()).toEqual([0, 1, 2, 3, 4]);
    });

    it('returns empty array for empty input without invoking the worker', async () => {
        let called = 0;
        const result = await runWithConcurrency([], 5, async () => {
            called += 1;
            return 1;
        });
        expect(result).toEqual([]);
        expect(called).toBe(0);
    });

    it('uses worker count = items.length when items < limit', async () => {
        // Smoke check: doesn't deadlock or error when limit > items.length.
        const result = await runWithConcurrency([1, 2], 100, async (i) => i + 1);
        expect(result).toEqual([2, 3]);
    });

    it('throws on non-positive limit', async () => {
        await expect(runWithConcurrency([1], 0, async () => 1)).rejects.toThrow();
        await expect(runWithConcurrency([1], -1, async () => 1)).rejects.toThrow();
    });
});

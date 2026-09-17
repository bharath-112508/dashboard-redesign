import { describe, it, expect } from 'vitest';

import { presentedAvailable, recomputeAvailable } from './leave-balance.model.js';

/**
 * The published "days left" figure. `recomputeAvailable` is the raw
 * arithmetic; `presentedAvailable` is what consumers may show or sum.
 */

const row = (over: Partial<Record<string, number>> = {}) =>
    ({
        allocated: 0,
        carried_forward: 0,
        adjusted: 0,
        used: 0,
        pending: 0,
        monthly_forfeited: 0,
        ...over,
    }) as Parameters<typeof recomputeAvailable>[0];

describe('recomputeAvailable', () => {
    it('nets credits against everything spent or held', () => {
        expect(recomputeAvailable(row({ allocated: 12, carried_forward: 3, adjusted: 1, used: 4, pending: 2 }))).toBe(
            10
        );
    });

    it('goes negative for an uncapped type, which is why the helper below exists', () => {
        expect(recomputeAvailable(row({ used: 2 }))).toBe(-2);
    });
});

describe('presentedAvailable', () => {
    it('matches the raw figure for an ordinary capped type', () => {
        expect(presentedAvailable(row({ allocated: 12, used: 4 }), { is_unlimited: false })).toBe(8);
    });

    it('reports nothing left to count for an uncapped type instead of a negative', () => {
        // WFH: allocated nothing, never checked on apply. Two days booked
        // rendered as "-2 remaining", and a 45-day pending row pulled an
        // employee's dashboard total down by 45.
        expect(presentedAvailable(row({ used: 2 }), { is_unlimited: true })).toBe(0);
        expect(presentedAvailable(row({ pending: 45 }), { is_unlimited: true })).toBe(0);
    });

    it('treats a missing or unknown leave type as capped', () => {
        // Defaulting the other way would silently zero a real balance whose
        // type row failed to load.
        expect(presentedAvailable(row({ allocated: 12, used: 4 }), null)).toBe(8);
        expect(presentedAvailable(row({ allocated: 12, used: 4 }), undefined)).toBe(8);
        expect(presentedAvailable(row({ allocated: 12, used: 4 }), {})).toBe(8);
    });

    it('still reports a genuine overdraft on a capped type', () => {
        // Casual leave is allowed to go negative when an approver signs off,
        // so the clamp must be about the absence of a cap, not about sign.
        expect(presentedAvailable(row({ allocated: 2, used: 5 }), { is_unlimited: false })).toBe(-3);
    });
});

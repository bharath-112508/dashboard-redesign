// src/utils/dashboard-range.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveDashboardRange, enumerateDates, resolveCustomRange, resolveAnalyticsRange } from './dashboard-range.js';

describe('resolveDashboardRange', () => {
    beforeEach(() => {
        // 2026-06-11 is a Thursday. 12:00 UTC = 17:30 IST, same calendar day.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('today = single IST day, prev = yesterday', () => {
        const r = resolveDashboardRange('today');
        expect(r).toMatchObject({
            key: 'today',
            from: '2026-06-11',
            to: '2026-06-11',
            prev_from: '2026-06-10',
            prev_to: '2026-06-10',
            label: 'Today',
        });
    });

    it('week starts Monday (IST)', () => {
        const r = resolveDashboardRange('week');
        expect(r.from).toBe('2026-06-08'); // Monday
        expect(r.to).toBe('2026-06-11');
        expect(r.prev_from).toBe('2026-06-01');
        expect(r.prev_to).toBe('2026-06-07');
    });

    it('month = month-start..today, prev = full previous month', () => {
        const r = resolveDashboardRange('month');
        expect(r).toMatchObject({
            from: '2026-06-01',
            to: '2026-06-11',
            prev_from: '2026-05-01',
            prev_to: '2026-05-31',
        });
    });

    it('30d = rolling 30 incl today, prev = 30 before that', () => {
        const r = resolveDashboardRange('30d');
        expect(r.from).toBe('2026-05-13');
        expect(r.prev_from).toBe('2026-04-13');
        expect(r.prev_to).toBe('2026-05-12');
    });

    it('quarter = Q2 start for June', () => {
        const r = resolveDashboardRange('quarter');
        expect(r.from).toBe('2026-04-01');
        expect(r.prev_from).toBe('2026-01-01');
        expect(r.prev_to).toBe('2026-03-31');
    });

    it('IST day boundary: 20:00 UTC = next day IST', () => {
        vi.setSystemTime(new Date('2026-06-11T20:00:00.000Z')); // 01:30 IST Jun 12
        expect(resolveDashboardRange('today').from).toBe('2026-06-12');
    });
});

describe('enumerateDates', () => {
    it('inclusive list', () => {
        expect(enumerateDates('2026-06-09', '2026-06-11')).toEqual(['2026-06-09', '2026-06-10', '2026-06-11']);
    });

    it('returns [] when from > to', () => {
        expect(enumerateDates('2026-06-11', '2026-06-09')).toEqual([]);
    });
});

describe('resolveCustomRange', () => {
    it('returns the window and the equally-long previous window', () => {
        const r = resolveCustomRange('2026-07-10', '2026-07-19'); // 10 days
        expect(r.from).toBe('2026-07-10');
        expect(r.to).toBe('2026-07-19');
        expect(r.prev_to).toBe('2026-07-09');
        expect(r.prev_from).toBe('2026-06-30'); // 10 days before prev_to inclusive
        expect(r.key).toBe('custom');
    });
    it('treats a single day as from==to', () => {
        const r = resolveCustomRange('2026-07-10', '2026-07-10');
        expect(r.from).toBe(r.to);
        expect(r.prev_from).toBe('2026-07-09');
        expect(r.prev_to).toBe('2026-07-09');
    });
    it('carries a sentence-friendly insight_label and a natural display label', () => {
        const r = resolveCustomRange('2026-06-01', '2026-07-23');
        // insight_label must read after a verb: "… completed in the selected range."
        expect(r.insight_label).toBe('in the selected range');
        // label is a human date span (not the raw ISO), shown as a subtitle.
        expect(r.label).toBe('1 Jun – 23 Jul 2026');
        expect(r.prev_label).toBe('the previous period');
    });
});

describe('insight_label mirrors label for presets', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('every preset sets insight_label === label', () => {
        for (const key of ['today', 'week', 'month', '30d', 'quarter'] as const) {
            const r = resolveDashboardRange(key);
            expect(r.insight_label).toBe(r.label);
        }
    });
});

describe('resolveAnalyticsRange', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('defaults to month when neither range nor from/to is given', () => {
        expect(resolveAnalyticsRange({}).key).toBe('month');
    });
    it('honours a preset key', () => {
        expect(resolveAnalyticsRange({ range: 'week' }).key).toBe('week');
    });
    it('a custom from/to window wins over a preset key', () => {
        const r = resolveAnalyticsRange({ range: 'week', from: '2026-05-01', to: '2026-05-31' });
        expect(r.key).toBe('custom');
        expect(r.from).toBe('2026-05-01');
        expect(r.to).toBe('2026-05-31');
    });
});

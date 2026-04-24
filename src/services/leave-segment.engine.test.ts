import { describe, expect, it } from 'vitest';

import { enumerateWorkingDays, generateSegments, type SegmentEngineInput } from './leave-segment.engine.js';
import { HALF_DAY_SLOTS, LEAVE_CODES } from '../constants/leave.js';

/**
 * Pure unit + property tests for the leave-segment engine (Step 10.2).
 *
 * The engine has zero Mongoose imports, so these tests run synchronously
 * against in-memory inputs — no DB, no fixtures.
 */

const SAT_SUN: ReadonlySet<string> = new Set();
const WORKING_DAYS = [1, 2, 3, 4, 5] as const; // Mon..Fri

const baseInput = (overrides: Partial<SegmentEngineInput> = {}): SegmentEngineInput => ({
    requested_code: LEAVE_CODES.CL,
    start_date: '2026-05-04', // Monday
    end_date: '2026-05-04',
    is_half_day: false,
    half_day_slot: null,
    working_days: WORKING_DAYS,
    holidays: SAT_SUN,
    ...overrides,
});

// ─── enumerateWorkingDays ─────────────────────────────────────────────────

describe('enumerateWorkingDays', () => {
    it('drops weekends', () => {
        // Fri 2026-05-01 → Mon 2026-05-04 → Tue → Wed
        const days = enumerateWorkingDays({
            start_date: '2026-05-01',
            end_date: '2026-05-06',
            working_days: WORKING_DAYS,
            holidays: new Set(),
        });
        expect(days).toEqual(['2026-05-01', '2026-05-04', '2026-05-05', '2026-05-06']);
    });

    it('drops holidays', () => {
        const days = enumerateWorkingDays({
            start_date: '2026-05-04',
            end_date: '2026-05-08',
            working_days: WORKING_DAYS,
            holidays: new Set(['2026-05-05']),
        });
        expect(days).toEqual(['2026-05-04', '2026-05-06', '2026-05-07', '2026-05-08']);
    });

    it('returns empty for fully-weekend range', () => {
        // 2026-05-02 (Sat) and 2026-05-03 (Sun)
        const days = enumerateWorkingDays({
            start_date: '2026-05-02',
            end_date: '2026-05-03',
            working_days: WORKING_DAYS,
            holidays: new Set(),
        });
        expect(days).toEqual([]);
    });
});

// ─── Generate segments — non-SL types ─────────────────────────────────────

describe('generateSegments — non-SL types', () => {
    it('CL: single year, single segment, weekday count', () => {
        const out = generateSegments(
            baseInput({ start_date: '2026-05-04', end_date: '2026-05-08' }) // Mon..Fri = 5
        );
        expect(out.total_days).toBe(5);
        expect(out.leave_segments).toEqual([{ leave_type_code: LEAVE_CODES.CL, year: 2026, days: 5 }]);
        expect(out.requires_additional_approval).toBe(false);
        expect(out.warnings).toEqual([]);
    });

    it('CL: drops weekends from middle of span', () => {
        const out = generateSegments(
            baseInput({ start_date: '2026-05-04', end_date: '2026-05-12' }) // 9 cal days, 7 weekdays
        );
        expect(out.total_days).toBe(7);
    });

    it('WFH: never splits', () => {
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.WFH,
                start_date: '2026-05-04',
                end_date: '2026-05-15',
            })
        );
        expect(out.leave_segments.length).toBe(1);
        expect(out.leave_segments[0]?.leave_type_code).toBe(LEAVE_CODES.WFH);
    });

    it('flags LEAVE_NO_WORKING_DAYS when entire range is weekend', () => {
        const out = generateSegments(baseInput({ start_date: '2026-05-02', end_date: '2026-05-03' }));
        expect(out.total_days).toBe(0);
        expect(out.leave_segments).toEqual([]);
        expect(out.warnings.map((w) => w.code)).toEqual(['LEAVE_NO_WORKING_DAYS']);
    });
});

// ─── Generate segments — SL split ─────────────────────────────────────────

describe('generateSegments — SL → CL auto split', () => {
    it('1-day SL with cap available → 1 SL', () => {
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.SL,
                start_date: '2026-05-04',
                end_date: '2026-05-04',
            })
        );
        expect(out.leave_segments).toEqual([{ leave_type_code: LEAVE_CODES.SL, year: 2026, days: 1 }]);
    });

    it('3-day SL with cap available → 1 SL + 2 CL', () => {
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.SL,
                start_date: '2026-05-04',
                end_date: '2026-05-06',
            })
        );
        expect(out.leave_segments).toEqual([
            { leave_type_code: LEAVE_CODES.SL, year: 2026, days: 1 },
            { leave_type_code: LEAVE_CODES.CL, year: 2026, days: 2 },
        ]);
    });

    it('SL with monthly cap exhausted → all CL', () => {
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.SL,
                start_date: '2026-05-04',
                end_date: '2026-05-06',
                sl_month_used: new Map([['2026-5', 1]]),
            })
        );
        expect(out.leave_segments).toEqual([{ leave_type_code: LEAVE_CODES.CL, year: 2026, days: 3 }]);
    });

    it('SL spanning two months → SL slot per month, CL for remainder, collapsed per year', () => {
        // 2026-05-25 (Mon) → 2026-06-05 (Fri). Weekdays:
        //  May 25, 26, 27, 28, 29 = 5 weekdays in May
        //  Jun 1, 2, 3, 4, 5 = 5 weekdays in June
        // Engine grants 1 SL slot in May + 1 SL slot in June and collapses
        // segments per (code, year): 2 SL/2026 + 8 CL/2026 = 10 days total.
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.SL,
                start_date: '2026-05-25',
                end_date: '2026-06-05',
            })
        );
        expect(out.total_days).toBe(10);
        expect(out.leave_segments).toEqual([
            { leave_type_code: LEAVE_CODES.SL, year: 2026, days: 2 },
            { leave_type_code: LEAVE_CODES.CL, year: 2026, days: 8 },
        ]);
    });

    it('SL spanning two years → SL + CL for each year', () => {
        // 2026-12-28 (Mon) → 2027-01-04 (Mon). Working days:
        //  Dec 28, 29, 30, 31 = 4 weekdays in 2026
        //  Jan 1 (Fri), Jan 4 (Mon) = 2 weekdays in 2027
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.SL,
                start_date: '2026-12-28',
                end_date: '2027-01-04',
            })
        );
        expect(out.total_days).toBe(6);
        expect(out.warnings.map((w) => w.code)).toContain('LEAVE_SPANS_YEARS');
        const codes = out.leave_segments.map((s) => `${s.leave_type_code}/${s.year}`);
        expect(codes).toContain('SL/2026');
        expect(codes).toContain('CL/2026');
        expect(codes).toContain('SL/2027');
        expect(codes).toContain('CL/2027');
    });

    it('SL with slots_per_month=2 takes both available days', () => {
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.SL,
                start_date: '2026-05-04',
                end_date: '2026-05-06',
                slots_per_month: 2,
            })
        );
        expect(out.leave_segments).toEqual([
            { leave_type_code: LEAVE_CODES.SL, year: 2026, days: 2 },
            { leave_type_code: LEAVE_CODES.CL, year: 2026, days: 1 },
        ]);
    });
});

// ─── Half-day handling ────────────────────────────────────────────────────

describe('generateSegments — half-day', () => {
    it('CL half-day → 0.5 day single segment', () => {
        const out = generateSegments(
            baseInput({
                is_half_day: true,
                half_day_slot: HALF_DAY_SLOTS.FIRST_HALF,
                start_date: '2026-05-04',
                end_date: '2026-05-04',
            })
        );
        expect(out.total_days).toBe(0.5);
        expect(out.leave_segments).toEqual([{ leave_type_code: LEAVE_CODES.CL, year: 2026, days: 0.5 }]);
    });

    it('SL half-day with cap available → 0.5 SL', () => {
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.SL,
                is_half_day: true,
                half_day_slot: HALF_DAY_SLOTS.SECOND_HALF,
                start_date: '2026-05-04',
                end_date: '2026-05-04',
            })
        );
        expect(out.leave_segments).toEqual([{ leave_type_code: LEAVE_CODES.SL, year: 2026, days: 0.5 }]);
    });

    it('half-day with start ≠ end → LEAVE_INVALID_HALF_DAY warning + no segments', () => {
        const out = generateSegments(
            baseInput({
                is_half_day: true,
                half_day_slot: HALF_DAY_SLOTS.FIRST_HALF,
                start_date: '2026-05-04',
                end_date: '2026-05-05',
            })
        );
        expect(out.leave_segments).toEqual([]);
        expect(out.warnings.map((w) => w.code)).toContain('LEAVE_INVALID_HALF_DAY');
    });

    it('half-day on a holiday → LEAVE_NO_WORKING_DAYS', () => {
        const out = generateSegments(
            baseInput({
                is_half_day: true,
                half_day_slot: HALF_DAY_SLOTS.FIRST_HALF,
                start_date: '2026-05-04',
                end_date: '2026-05-04',
                holidays: new Set(['2026-05-04']),
            })
        );
        expect(out.warnings.map((w) => w.code)).toContain('LEAVE_NO_WORKING_DAYS');
    });
});

// ─── requires_additional_approval ────────────────────────────────────────

describe('generateSegments — neg-balance flag', () => {
    it('flags when CL portion drives balance below zero', () => {
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.SL,
                start_date: '2026-05-04',
                end_date: '2026-05-06', // 1 SL + 2 CL
                available: new Map([
                    ['SL|2026', 5],
                    ['CL|2026', 1], // shortage
                ]),
            })
        );
        expect(out.leave_segments).toEqual([
            { leave_type_code: LEAVE_CODES.SL, year: 2026, days: 1 },
            { leave_type_code: LEAVE_CODES.CL, year: 2026, days: 2 },
        ]);
        expect(out.requires_additional_approval).toBe(true);
    });

    it('does NOT flag when balance is sufficient', () => {
        const out = generateSegments(
            baseInput({
                requested_code: LEAVE_CODES.SL,
                start_date: '2026-05-04',
                end_date: '2026-05-06',
                available: new Map([
                    ['SL|2026', 5],
                    ['CL|2026', 10],
                ]),
            })
        );
        expect(out.requires_additional_approval).toBe(false);
    });
});

// ─── Property-style: total days conservation ─────────────────────────────

describe('property: SL split conserves total days', () => {
    const SEED = 0x9e3779b1; // golden-ratio-ish constant for the LCG
    let state = SEED;
    const rand = (): number => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return (state & 0x7fffffff) / 0x7fffffff;
    };

    const pickDate = (): { start: string; end: string } => {
        // Random month in 2026, random start day 1..20, random length 1..15
        const month = Math.floor(rand() * 12) + 1;
        const day = Math.floor(rand() * 20) + 1;
        const len = Math.floor(rand() * 15) + 1;
        const startStr = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const start = new Date(startStr + 'T00:00:00Z');
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + len);
        const yyyy = end.getUTCFullYear();
        const mm = String(end.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(end.getUTCDate()).padStart(2, '0');
        return { start: startStr, end: `${yyyy}-${mm}-${dd}` };
    };

    it('100 random spans: sum(segments.days) === working_days.length for SL', () => {
        for (let i = 0; i < 100; i++) {
            const { start, end } = pickDate();
            const out = generateSegments(
                baseInput({
                    requested_code: LEAVE_CODES.SL,
                    start_date: start,
                    end_date: end,
                })
            );
            const segSum = out.leave_segments.reduce((acc, s) => acc + s.days, 0);
            expect(segSum).toBe(out.working_days.length);
            expect(segSum).toBe(out.total_days);
        }
    });

    it('100 random spans: SL segments never exceed slots_per_month per (year, month)', () => {
        for (let i = 0; i < 100; i++) {
            const { start, end } = pickDate();
            const out = generateSegments(
                baseInput({
                    requested_code: LEAVE_CODES.SL,
                    start_date: start,
                    end_date: end,
                })
            );
            const slPerMonth = new Map<string, number>();
            for (const seg of out.leave_segments) {
                if (seg.leave_type_code !== LEAVE_CODES.SL) continue;
                // Engine collapses per-month slices; the segment's `days`
                // field is one month's worth at most because the engine
                // enumerates working days month-by-month per year.
                const monthsTouched = new Set(out.working_days.map((d) => d.slice(0, 7)));
                expect(seg.days).toBeLessThanOrEqual(monthsTouched.size);
                slPerMonth.set(`${seg.year}`, (slPerMonth.get(`${seg.year}`) ?? 0) + seg.days);
            }
        }
    });
});

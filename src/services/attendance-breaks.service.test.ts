// src/services/attendance-breaks.service.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: vi.fn(async () => ({
        work_schedule: { daily_expected_hours: 8 },
        attendance: { break_allowance_minutes: 60 },
    })),
}));

import { segmentBreakMinutes, breakTotalsAcrossSegments, computeWorkedAcrossSegments } from './attendance.service.js';

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 18, h, m, 0));
const punch = (d: Date) => ({ time: d, method: 'manual' as const, location_id: null, ip: '' });
const brk = (type: string, s: Date, e: Date | null) => ({
    break_type: type as never,
    start: { time: s, source: 'app' as const },
    end: e ? { time: e, source: 'app' as const } : null,
});

describe('segmentBreakMinutes', () => {
    it('sums only CLOSED breaks', () => {
        const seg = {
            check_in: punch(t(9)),
            check_out: punch(t(18)),
            breaks: [brk('lunch', t(12), t(13)), brk('tea', t(15), null)], // tea open → ignored
        };
        expect(segmentBreakMinutes(seg as never)).toBe(60);
    });
});

describe('breakTotalsAcrossSegments', () => {
    it('totals closed breaks and splits by type', () => {
        const segs = [
            { check_in: punch(t(9)), check_out: punch(t(13)), breaks: [brk('lunch', t(12), t(12, 35))] },
            {
                check_in: punch(t(14)),
                check_out: null,
                breaks: [brk('tea', t(15), t(15, 10)), brk('other', t(16), null)],
            },
        ];
        expect(breakTotalsAcrossSegments(segs as never)).toEqual({
            total_break_minutes: 45,
            break_minutes_by_type: { lunch: 35, tea: 10, other: 0 },
        });
    });
});

describe('computeWorkedAcrossSegments subtracts breaks', () => {
    it('net worked = gross - closed breaks; overtime on net', async () => {
        const segs = [
            { check_in: punch(t(11)), check_out: punch(t(20)), breaks: [brk('lunch', t(13), t(14))] }, // 9h gross - 1h = 8h net
        ];
        const out = await computeWorkedAcrossSegments(segs as never);
        expect(out.total_worked_minutes).toBe(480); // 8h
        expect(out.overtime_minutes).toBe(0); // exactly expected
        expect(out.total_break_minutes).toBe(60);
        expect(out.break_minutes_by_type.lunch).toBe(60);
    });

    it('never goes negative when breaks exceed gross', async () => {
        const segs = [{ check_in: punch(t(9)), check_out: punch(t(9, 30)), breaks: [brk('other', t(9), t(9, 45))] }];
        const out = await computeWorkedAcrossSegments(segs as never);
        expect(out.total_worked_minutes).toBe(0);
    });
});

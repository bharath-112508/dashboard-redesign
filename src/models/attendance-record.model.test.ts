import { describe, expect, it } from 'vitest';

import { AttendanceRecord } from './attendance-record.model.js';

describe('AttendanceRecord break fields', () => {
    it('defaults breaks to [] and the denormalized break totals to 0', () => {
        const doc = new AttendanceRecord({
            user_id: '6a2abb7989a4aa4c72cd670e',
            local_date: '2026-06-18',
            segments: [
                { check_in: { time: new Date(), method: 'manual', location_id: null, ip: '' }, check_out: null },
            ],
            status: 'present',
        });
        expect(doc.segments[0]!.breaks).toEqual([]);
        expect(doc.total_break_minutes).toBe(0);
        expect(doc.break_minutes_by_type.lunch).toBe(0);
        expect(doc.break_minutes_by_type.tea).toBe(0);
        expect(doc.break_minutes_by_type.other).toBe(0);
    });

    it('accepts a break session nested in a segment', () => {
        const start = new Date();
        const doc = new AttendanceRecord({
            user_id: '6a2abb7989a4aa4c72cd670e',
            local_date: '2026-06-18',
            segments: [
                {
                    check_in: { time: start, method: 'manual', location_id: null, ip: '' },
                    check_out: null,
                    breaks: [{ break_type: 'lunch', start: { time: start, source: 'slack' }, end: null }],
                },
            ],
            status: 'present',
        });
        expect(doc.segments[0]!.breaks[0]!.break_type).toBe('lunch');
        expect(doc.segments[0]!.breaks[0]!.start.source).toBe('slack');
        expect(doc.segments[0]!.breaks[0]!.end).toBeNull();
    });
});

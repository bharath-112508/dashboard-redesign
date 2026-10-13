// src/services/attendance-break-actions.service.test.ts
// Tests for startBreak / endBreak — split from attendance-breaks.service.test.ts
// because the whole-file vi.mock for AttendanceRecord must not affect the
// helper-function tests that don't depend on the DB model.
import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: vi.fn(async () => ({
        work_schedule: { daily_expected_hours: 8 },
        attendance: { break_allowance_minutes: 60 },
    })),
}));

// Mock the model so we control today's record.
const saveMock = vi.fn(async function (this: unknown) {
    return this;
});
let todayDoc: Record<string, unknown> | null = null;
vi.mock('../models/attendance-record.model.js', async (orig) => {
    const actual = await orig<typeof import('../models/attendance-record.model.js')>();
    return {
        ...actual,
        AttendanceRecord: {
            findOne: vi.fn(async () => todayDoc),
        },
    };
});

const { showBreakOnSlack, clearBreakFromSlack } = vi.hoisted(() => ({
    showBreakOnSlack: vi.fn(async () => {}),
    clearBreakFromSlack: vi.fn(async () => {}),
}));
vi.mock('./slack-status-publish.service.js', () => ({ showBreakOnSlack, clearBreakFromSlack }));

import { startBreak, endBreak } from './attendance.service.js';
import { ERROR_CODES } from '../constants/error-codes.js';

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 18, h, m, 0));
const punch = (d: Date) => ({ time: d, method: 'manual' as const, location_id: null, ip: '' });
const brk = (type: string, s: Date, e: Date | null) => ({
    break_type: type as never,
    start: { time: s, source: 'app' as const },
    end: e ? { time: e, source: 'app' as const } : null,
});

const makeDoc = (segments: unknown[]) => ({
    segments,
    toJSON() {
        return { segments: this.segments };
    },
    markModified: vi.fn(),
    save: saveMock,
    total_worked_minutes: 0,
    overtime_minutes: 0,
    total_break_minutes: 0,
    break_minutes_by_type: { lunch: 0, tea: 0, other: 0 },
    check_in: null,
    check_out: null,
});

const uid = new Types.ObjectId();
const openSeg = () => ({ check_in: punch(t(11)), check_out: null, breaks: [] as unknown[] });

describe('startBreak', () => {
    it('NOT_CHECKED_IN when there is no open segment', async () => {
        todayDoc = null;
        await expect(startBreak(uid, 'lunch', 'app')).rejects.toMatchObject({ code: ERROR_CODES.NOT_CHECKED_IN });
    });

    it('appends an open break to the latest open segment', async () => {
        const seg = openSeg();
        todayDoc = makeDoc([seg]);
        await startBreak(uid, 'tea', 'slack');
        expect(seg.breaks).toHaveLength(1);
        expect((seg.breaks[0] as { break_type: string }).break_type).toBe('tea');
        expect((seg.breaks[0] as { end: unknown }).end).toBeNull();
    });

    it('mirrors the break onto the Slack status — except one the Slack status started', async () => {
        showBreakOnSlack.mockClear();
        todayDoc = makeDoc([openSeg()]);
        await startBreak(uid, 'lunch', 'app');
        expect(showBreakOnSlack).toHaveBeenCalledWith(uid, 'lunch');
        showBreakOnSlack.mockClear();
        todayDoc = makeDoc([openSeg()]);
        await startBreak(uid, 'lunch', 'slack_status');
        expect(showBreakOnSlack).not.toHaveBeenCalled();
    });

    it('ALREADY_ON_BREAK when a break is already open', async () => {
        const seg = { check_in: punch(t(11)), check_out: null, breaks: [brk('lunch', t(12), null)] };
        todayDoc = makeDoc([seg]);
        await expect(startBreak(uid, 'tea', 'app')).rejects.toMatchObject({ code: ERROR_CODES.ALREADY_ON_BREAK });
    });
});

describe('endBreak', () => {
    it('NOT_ON_BREAK when nothing is open', async () => {
        todayDoc = makeDoc([openSeg()]);
        await expect(endBreak(uid, 'app')).rejects.toMatchObject({ code: ERROR_CODES.NOT_ON_BREAK });
    });

    it('closes the open break and recomputes break totals', async () => {
        // Use t(3) (03:00 UTC) as break start so it is always in the past when
        // the test runs (endBreak closes it with new Date() / wall clock).
        const seg = { check_in: punch(t(3)), check_out: null, breaks: [brk('lunch', t(3), null)] };
        todayDoc = makeDoc([seg]);
        await endBreak(uid, 'slack');
        expect((seg.breaks[0] as { end: unknown }).end).not.toBeNull();
        // open segment → worked stays 0, but break total reflects the closed break
        expect((todayDoc as { total_break_minutes: number }).total_break_minutes).toBeGreaterThan(0);
    });

    it('restores the Slack status — except when the Slack status itself ended the break', async () => {
        clearBreakFromSlack.mockClear();
        todayDoc = makeDoc([{ check_in: punch(t(3)), check_out: null, breaks: [brk('tea', t(3), null)] }]);
        await endBreak(uid, 'app');
        expect(clearBreakFromSlack).toHaveBeenCalledWith(uid);
        clearBreakFromSlack.mockClear();
        todayDoc = makeDoc([{ check_in: punch(t(3)), check_out: null, breaks: [brk('tea', t(3), null)] }]);
        await endBreak(uid, 'slack_status');
        expect(clearBreakFromSlack).not.toHaveBeenCalled();
    });
});

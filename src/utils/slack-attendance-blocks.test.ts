import { describe, expect, it } from 'vitest';

import {
    SLACK_ACTION_ATTENDANCE_CHECK_IN,
    SLACK_ACTION_ATTENDANCE_CHECK_OUT,
    SLACK_ACTION_BREAK_START_LUNCH,
    SLACK_ACTION_BREAK_START_TEA,
    SLACK_ACTION_BREAK_START_OTHER,
    SLACK_ACTION_BREAK_END,
} from '../constants/slack.js';
import {
    attendanceHeaderBlocks,
    buildAttendanceHomeView,
    buildCheckinNudgeMessage,
    buildCheckoutReminderMessage,
    formatTimeIST,
    formatDuration,
} from './slack-attendance-blocks.js';

// 2026-06-16T05:33:00Z == 11:03 IST
const inAt = new Date('2026-06-16T05:33:00.000Z');
const outAt = new Date('2026-06-16T13:00:00.000Z'); // 18:30 IST

const actionIds = (view: { blocks: Array<Record<string, unknown>> }): string[] =>
    view.blocks
        .filter((b) => b.type === 'actions')
        .flatMap((b) => (b.elements as Array<{ action_id?: string }>).map((e) => e.action_id ?? ''));

describe('formatTimeIST / formatDuration', () => {
    it('formats a UTC instant as HH:MM IST', () => {
        expect(formatTimeIST(inAt)).toBe('11:03');
    });
    it('formats minutes as Xh Ym', () => {
        expect(formatDuration(134)).toBe('2h 14m');
        expect(formatDuration(0)).toBe('0h 0m');
    });
});

describe('buildAttendanceHomeView', () => {
    it('shows only Check In when there is no record', () => {
        const view = buildAttendanceHomeView(null, 'Raj') as { type: string; blocks: Array<Record<string, unknown>> };
        expect(view.type).toBe('home');
        expect(actionIds(view)).toEqual([SLACK_ACTION_ATTENDANCE_CHECK_IN]);
    });

    it('shows Lunch / Tea / Break + Check Out when a segment is open (no active break)', () => {
        const record = {
            segments: [{ check_in: { time: inAt }, check_out: null, breaks: [] }],
            total_worked_minutes: 0,
        };
        const view = buildAttendanceHomeView(record, 'Raj') as { blocks: Array<Record<string, unknown>> };
        const ids = actionIds(view);
        const breakStarts = ids.filter((id) => id.startsWith('break_start'));
        expect(breakStarts).toEqual([
            SLACK_ACTION_BREAK_START_LUNCH,
            SLACK_ACTION_BREAK_START_TEA,
            SLACK_ACTION_BREAK_START_OTHER,
        ]);
        expect(ids).toContain(SLACK_ACTION_ATTENDANCE_CHECK_OUT);
        expect(ids).not.toContain(SLACK_ACTION_BREAK_END);
    });

    it('shows End break + Check Out when a break is open', () => {
        const record = {
            segments: [
                {
                    check_in: { time: inAt },
                    check_out: null,
                    breaks: [{ break_type: 'tea', start: { time: inAt }, end: null }],
                },
            ],
            total_worked_minutes: 0,
        };
        const view = buildAttendanceHomeView(record, 'Raj') as { blocks: Array<Record<string, unknown>> };
        const ids = actionIds(view);
        expect(ids).toContain(SLACK_ACTION_BREAK_END);
        expect(ids).toContain(SLACK_ACTION_ATTENDANCE_CHECK_OUT);
        expect(ids.filter((id) => id.startsWith('break_start'))).toEqual([]);
    });

    it('shows Check In again once all segments are closed (re-check-in / resume)', () => {
        const record = {
            segments: [{ check_in: { time: inAt }, check_out: { time: outAt } }],
            total_worked_minutes: 447,
        };
        const view = buildAttendanceHomeView(record, 'Raj') as { blocks: Array<Record<string, unknown>> };
        expect(actionIds(view)).toEqual([SLACK_ACTION_ATTENDANCE_CHECK_IN]);
    });
});

describe('attendanceHeaderBlocks', () => {
    it('returns header + status + the state-valid button (not a full view)', () => {
        const blocks = attendanceHeaderBlocks(null, 'Raj');
        expect(Array.isArray(blocks)).toBe(true);
        const actions = blocks.filter((b: unknown) => (b as { type?: string }).type === 'actions');
        const ids = actions.flatMap((b: unknown) =>
            (b as { elements: Array<{ action_id?: string }> }).elements.map((e) => e.action_id)
        );
        expect(ids).toEqual([SLACK_ACTION_ATTENDANCE_CHECK_IN]);
    });
});

describe('attendanceHeaderBlocks — break sub-UI', () => {
    it('shows Lunch / Tea / Break buttons when checked in and not on a break', () => {
        const rec = {
            segments: [{ check_in: { time: new Date() }, check_out: null, breaks: [] }],
            total_break_minutes: 0,
        };
        const blocks = attendanceHeaderBlocks(rec as never, 'Vivek');
        const s = JSON.stringify(blocks);
        expect(s).toContain('break_start_lunch');
        expect(s).toContain('break_start_tea');
        expect(s).toContain('break_start_other');
        expect(s).not.toContain('break_end');
    });

    it('shows End break + a type-free on-break line when a break is open', () => {
        const rec = {
            segments: [
                {
                    check_in: { time: new Date() },
                    check_out: null,
                    breaks: [{ break_type: 'tea', start: { time: new Date() }, end: null }],
                },
            ],
            total_break_minutes: 0,
        };
        const blocks = attendanceHeaderBlocks(rec as never, 'Vivek');
        const s = JSON.stringify(blocks);
        expect(s).toContain('break_end');
        expect(s).toContain('On a break');
        // No break-type label leaks into the status line.
        expect(s).not.toContain('(*tea*)');
    });

    it('lists break sessions with type label, times + duration', () => {
        const bIn = new Date('2026-06-16T05:33:00.000Z'); // 11:03 IST
        const bStart = new Date('2026-06-16T08:30:00.000Z'); // 14:00 IST
        const bEnd = new Date('2026-06-16T08:55:00.000Z'); // 14:25 IST
        const lunchStart = new Date('2026-06-16T07:00:00.000Z'); // 12:30 IST
        const lunchEnd = new Date('2026-06-16T07:30:00.000Z'); // 13:00 IST
        const rec = {
            segments: [
                {
                    check_in: { time: bIn },
                    check_out: null,
                    breaks: [
                        { break_type: 'lunch', start: { time: lunchStart }, end: { time: lunchEnd } },
                        { break_type: 'other', start: { time: bStart }, end: { time: bEnd } },
                    ],
                },
            ],
            total_break_minutes: 55,
        };
        const blocks = attendanceHeaderBlocks(rec as never, 'Vivek');
        const s = JSON.stringify(blocks);
        expect(s).toContain('Break sessions');
        expect(s).toContain('14:00 → 14:25');
        expect(s).toContain('0h 25m');
        // Each session is tagged with its type (other → "Break").
        expect(s).toContain('*Lunch*');
        expect(s).toContain('*Break*');
    });
});

describe('nudge messages', () => {
    it('check-in nudge carries a Check In button + fallback text', () => {
        const msg = buildCheckinNudgeMessage('Raj');
        expect(msg.text).toMatch(/check in/i);
        expect(actionIds({ blocks: msg.blocks })).toEqual([SLACK_ACTION_ATTENDANCE_CHECK_IN]);
    });
    it('checkout reminder carries a Check Out button + since-time', () => {
        const msg = buildCheckoutReminderMessage(inAt);
        expect(msg.text).toMatch(/check out/i);
        expect(actionIds({ blocks: msg.blocks })).toEqual([SLACK_ACTION_ATTENDANCE_CHECK_OUT]);
    });
});

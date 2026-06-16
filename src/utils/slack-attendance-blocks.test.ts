import { describe, expect, it } from 'vitest';

import { SLACK_ACTION_ATTENDANCE_CHECK_IN, SLACK_ACTION_ATTENDANCE_CHECK_OUT } from '../constants/slack.js';
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

    it('shows only Check Out when a segment is open', () => {
        const record = { segments: [{ check_in: { time: inAt }, check_out: null }], total_worked_minutes: 0 };
        const view = buildAttendanceHomeView(record, 'Raj') as { blocks: Array<Record<string, unknown>> };
        expect(actionIds(view)).toEqual([SLACK_ACTION_ATTENDANCE_CHECK_OUT]);
    });

    it('shows Check In again when the day is closed', () => {
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

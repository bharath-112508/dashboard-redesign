import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const { getOpenBreak, startBreak, endBreak } = vi.hoisted(() => ({
    getOpenBreak: vi.fn(),
    startBreak: vi.fn(),
    endBreak: vi.fn(),
}));
vi.mock('./attendance.service.js', () => ({ getOpenBreak, startBreak, endBreak }));
vi.mock('./role.service.js', () => ({ resolvePermissionsForUser: vi.fn() }));

import { breakTypeFromSlackStatus, syncBreakFromSlackStatus } from './slack-attendance.service.js';
import { ERROR_CODES } from '../constants/error-codes.js';

const uid = new Types.ObjectId();
const open = (break_type: string, source: string) => ({ break_type, start: { time: new Date(), source }, end: null });

describe('breakTypeFromSlackStatus', () => {
    it.each([
        [':hamburger:', '', 'lunch'],
        ['', 'Out for Lunch', 'lunch'],
        [':coffee:', '', 'tea'],
        ['', 'tea time', 'tea'],
        [':walking:', 'Short break', 'other'],
        ['', 'brb', 'other'],
        [':spiral_calendar_pad:', 'In a meeting', null],
        ['', '', null],
    ])('%s %s → %s', (emoji, text, expected) => {
        expect(breakTypeFromSlackStatus(emoji, text)).toBe(expected);
    });
});

describe('syncBreakFromSlackStatus', () => {
    beforeEach(() => vi.clearAllMocks());

    it('starts a break when not on one', async () => {
        getOpenBreak.mockResolvedValue(null);
        expect(await syncBreakFromSlackStatus(uid, 'lunch')).toBe(true);
        expect(startBreak).toHaveBeenCalledWith(uid, 'lunch', 'slack_status');
    });

    it('is a no-op when already on the same break (repeat profile events)', async () => {
        getOpenBreak.mockResolvedValue(open('lunch', 'slack_status'));
        expect(await syncBreakFromSlackStatus(uid, 'lunch')).toBe(false);
        expect(startBreak).not.toHaveBeenCalled();
    });

    it('switches type when the status changes 🍔 → ☕', async () => {
        getOpenBreak.mockResolvedValue(open('lunch', 'slack_status'));
        expect(await syncBreakFromSlackStatus(uid, 'tea')).toBe(true);
        expect(endBreak).toHaveBeenCalledWith(uid, 'slack_status');
        expect(startBreak).toHaveBeenCalledWith(uid, 'tea', 'slack_status');
    });

    it('ends a status-started break when the status clears', async () => {
        getOpenBreak.mockResolvedValue(open('tea', 'slack_status'));
        expect(await syncBreakFromSlackStatus(uid, null)).toBe(true);
        expect(endBreak).toHaveBeenCalledWith(uid, 'slack_status');
    });

    it('never touches a break started from the app', async () => {
        getOpenBreak.mockResolvedValue(open('lunch', 'app'));
        expect(await syncBreakFromSlackStatus(uid, null)).toBe(false);
        expect(await syncBreakFromSlackStatus(uid, 'tea')).toBe(false);
        expect(endBreak).not.toHaveBeenCalled();
        expect(startBreak).not.toHaveBeenCalled();
    });

    it('ignores the status when the user is not checked in', async () => {
        getOpenBreak.mockResolvedValue(null);
        startBreak.mockRejectedValueOnce(Object.assign(new Error(), { code: ERROR_CODES.NOT_CHECKED_IN }));
        expect(await syncBreakFromSlackStatus(uid, 'lunch')).toBe(false);
    });
});

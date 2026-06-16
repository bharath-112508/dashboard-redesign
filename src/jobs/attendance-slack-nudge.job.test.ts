import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('../models/user.model.js', () => ({ User: { find: vi.fn(), findByIdAndUpdate: vi.fn() } }));
vi.mock('../models/attendance-record.model.js', () => ({ AttendanceRecord: { find: vi.fn() } }));
vi.mock('../models/holiday.model.js', () => ({ Holiday: { exists: vi.fn() } }));
vi.mock('../models/leave-request.model.js', () => ({ LeaveRequest: { find: vi.fn() } }));
vi.mock('../services/settings.service.js', () => ({ getOrInitSettings: vi.fn() }));
vi.mock('../utils/slack.js', () => ({
    slackContextFrom: vi.fn(() => ({ enabled: true, botToken: 'xoxb-x' })),
    postOrUpdateSlackMessage: vi.fn(async () => ({ success: true })),
}));
vi.mock('../services/slack-user-mapping.service.js', () => ({ resolveSlackIdByEmail: vi.fn() }));

import { User } from '../models/user.model.js';
import { AttendanceRecord } from '../models/attendance-record.model.js';
import { Holiday } from '../models/holiday.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { getOrInitSettings } from '../services/settings.service.js';
import { postOrUpdateSlackMessage } from '../utils/slack.js';
import { sendCheckinNudges, sendCheckoutReminders } from './attendance-slack-nudge.job.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const selectStub = (rows: unknown[]) => ({ select: vi.fn().mockResolvedValue(rows) });
const distinctStub = (rows: unknown[]) => ({ distinct: vi.fn().mockResolvedValue(rows) });

afterEach(() => vi.clearAllMocks());

const enableSlack = () =>
    (getOrInitSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        slack: { enabled: true, attendance_nudges: { enabled: true } },
        work_schedule: { working_days: [1, 2, 3, 4, 5] },
    });

describe('sendCheckinNudges', () => {
    it('skips entirely when nudges are disabled', async () => {
        (getOrInitSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
            slack: { enabled: true, attendance_nudges: { enabled: false } },
            work_schedule: { working_days: [1, 2, 3, 4, 5] },
        });
        const summary = await sendCheckinNudges(new Date('2026-06-16T04:00:00Z'), log);
        expect(summary.skipped).toBe(true);
        expect(postOrUpdateSlackMessage).not.toHaveBeenCalled();
    });

    it('DMs a mapped, working, not-yet-checked-in user', async () => {
        enableSlack();
        const uid = new Types.ObjectId();
        (User.find as ReturnType<typeof vi.fn>).mockReturnValue(
            selectStub([{ _id: uid, email: 'a@b.com', full_name: 'Raj', slack_user_id: 'U1' }])
        );
        (Holiday.exists as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        (LeaveRequest.find as ReturnType<typeof vi.fn>).mockReturnValue(distinctStub([]));
        (AttendanceRecord.find as ReturnType<typeof vi.fn>).mockReturnValue(distinctStub([]));
        const summary = await sendCheckinNudges(new Date('2026-06-16T04:00:00Z'), log);
        expect(summary.notified).toBe(1);
        expect(postOrUpdateSlackMessage).toHaveBeenCalledOnce();
    });

    it('does not DM a user who already checked in', async () => {
        enableSlack();
        const uid = new Types.ObjectId();
        (User.find as ReturnType<typeof vi.fn>).mockReturnValue(
            selectStub([{ _id: uid, email: 'a@b.com', full_name: 'Raj', slack_user_id: 'U1' }])
        );
        (Holiday.exists as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        (LeaveRequest.find as ReturnType<typeof vi.fn>).mockReturnValue(distinctStub([]));
        (AttendanceRecord.find as ReturnType<typeof vi.fn>).mockReturnValue(distinctStub([uid]));
        const summary = await sendCheckinNudges(new Date('2026-06-16T04:00:00Z'), log);
        expect(summary.notified).toBe(0);
        expect(summary.already_checked_in).toBe(1);
    });

    it('skips the whole run on a holiday', async () => {
        enableSlack();
        (Holiday.exists as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: new Types.ObjectId() });
        (User.find as ReturnType<typeof vi.fn>).mockReturnValue(selectStub([]));
        (LeaveRequest.find as ReturnType<typeof vi.fn>).mockReturnValue(distinctStub([]));
        (AttendanceRecord.find as ReturnType<typeof vi.fn>).mockReturnValue(distinctStub([]));
        const summary = await sendCheckinNudges(new Date('2026-06-16T04:00:00Z'), log);
        expect(summary.non_working_day).toBe(true);
        expect(postOrUpdateSlackMessage).not.toHaveBeenCalled();
    });
});

describe('sendCheckoutReminders', () => {
    it('DMs users with an open segment', async () => {
        enableSlack();
        const uid = new Types.ObjectId();
        (AttendanceRecord.find as ReturnType<typeof vi.fn>).mockReturnValue(
            selectStub([{ user_id: uid, segments: [{ check_in: { time: new Date() }, check_out: null }] }])
        );
        (User.find as ReturnType<typeof vi.fn>).mockReturnValue(
            selectStub([{ _id: uid, email: 'a@b.com', full_name: 'Raj', slack_user_id: 'U1' }])
        );
        const summary = await sendCheckoutReminders(new Date('2026-06-16T14:30:00Z'), log);
        expect(summary.reminded).toBe(1);
        expect(postOrUpdateSlackMessage).toHaveBeenCalledOnce();
    });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Coverage focus for the timesheet-reminder cron.
 *
 * The job's responsibility:
 *   1. Load every active **internal** user (admin / manager / employee
 *      — clients are excluded).
 *   2. Skip users with an approved leave covering today (no nag while
 *      they're on holiday).
 *   3. Skip users who've already logged at least one timesheet entry
 *      today.
 *   4. Notify the rest.
 *   5. Emit a summary row recording {headcount, on_leave, already_logged,
 *      notified} so a single audit-log line tells ops what the run did.
 *
 * Pinning these branches catches regressions in either filter:
 *   - A regression dropping the on_leave skip would spam users on
 *     vacation.
 *   - A regression dropping the already_logged skip would spam users
 *     who DID log time but maybe finished early (ops trust would erode
 *     fast).
 */

const userFindMock = vi.fn();
const leaveRequestFindMock = vi.fn();
const userIdsWithEntriesOnMock = vi.fn();
const notifyTimesheetReminderMock = vi.fn();
const getOrInitSettingsMock = vi.fn();

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock },
}));

vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: { find: leaveRequestFindMock },
}));

vi.mock('../services/timesheet.service.js', () => ({
    userIdsWithEntriesOn: userIdsWithEntriesOnMock,
}));

vi.mock('../services/notification-dispatcher.service.js', () => ({
    notifyTimesheetReminder: notifyTimesheetReminderMock,
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: getOrInitSettingsMock,
}));

const job = await import('./timesheet-reminder.job.js');
import { ROLES } from '../constants/roles.js';

const makeUser = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    email: 'user@example.com',
    full_name: 'Sam',
    role: ROLES.EMPLOYEE,
    slack_user_id: null,
    slack_notifications_enabled: false,
    ...overrides,
});

const stubLogger = (): { info: ReturnType<typeof vi.fn> } => ({ info: vi.fn() });

beforeEach(() => {
    vi.resetAllMocks();
    // Default: settings provide a 7h threshold.
    getOrInitSettingsMock.mockResolvedValue({
        timesheet: { daily_warn_threshold_hours: 7 },
    });
});

describe('remindUnloggedUsers', () => {
    it('skips users on approved leave today (no vacation nag)', async () => {
        const onLeaveUser = makeUser();
        const otherUser = makeUser();
        userFindMock.mockReturnValueOnce({
            select: () => Promise.resolve([onLeaveUser, otherUser]),
        });
        leaveRequestFindMock.mockReturnValueOnce({
            distinct: () => Promise.resolve([onLeaveUser._id]),
        });
        userIdsWithEntriesOnMock.mockResolvedValueOnce(new Set<string>());

        const summary = await job.remindUnloggedUsers(new Date('2026-04-23T15:00:00Z'), stubLogger() as never);

        expect(summary.on_leave).toBe(1);
        expect(summary.notified).toBe(1);
        // The on-leave user MUST NOT be notified.
        expect(notifyTimesheetReminderMock).toHaveBeenCalledTimes(1);
        expect(notifyTimesheetReminderMock.mock.calls[0]![0].recipient._id).toBe(otherUser._id);
    });

    it('skips users who already logged at least one entry today', async () => {
        const loggedUser = makeUser();
        const otherUser = makeUser();
        userFindMock.mockReturnValueOnce({
            select: () => Promise.resolve([loggedUser, otherUser]),
        });
        leaveRequestFindMock.mockReturnValueOnce({
            distinct: () => Promise.resolve([]),
        });
        userIdsWithEntriesOnMock.mockResolvedValueOnce(new Set<string>([String(loggedUser._id)]));

        const summary = await job.remindUnloggedUsers(new Date(), stubLogger() as never);

        expect(summary.already_logged).toBe(1);
        expect(summary.notified).toBe(1);
        expect(notifyTimesheetReminderMock.mock.calls[0]![0].recipient._id).toBe(otherUser._id);
    });

    it('on_leave skip wins over already_logged when a user qualifies for both', async () => {
        // Edge case: a user is on approved leave AND has an entry today
        // (manager logged time on their behalf earlier, then the leave
        // got approved). The summary should count them ONCE under
        // on_leave, not twice or under the wrong bucket.
        const dualUser = makeUser();
        userFindMock.mockReturnValueOnce({
            select: () => Promise.resolve([dualUser]),
        });
        leaveRequestFindMock.mockReturnValueOnce({
            distinct: () => Promise.resolve([dualUser._id]),
        });
        userIdsWithEntriesOnMock.mockResolvedValueOnce(new Set<string>([String(dualUser._id)]));

        const summary = await job.remindUnloggedUsers(new Date(), stubLogger() as never);

        expect(summary.on_leave).toBe(1);
        expect(summary.already_logged).toBe(0);
        expect(summary.notified).toBe(0);
    });

    it('threads the settings expected_hours value into each notification call', async () => {
        // Pin: an admin who's set `daily_warn_threshold_hours: 6` in
        // settings should see "6 hours" in the reminder, not the
        // hardcoded default. A regression that ignored settings would
        // silently degrade per-tenant config.
        getOrInitSettingsMock.mockResolvedValueOnce({
            timesheet: { daily_warn_threshold_hours: 6 },
        });
        const user = makeUser();
        userFindMock.mockReturnValueOnce({ select: () => Promise.resolve([user]) });
        leaveRequestFindMock.mockReturnValueOnce({ distinct: () => Promise.resolve([]) });
        userIdsWithEntriesOnMock.mockResolvedValueOnce(new Set<string>());

        await job.remindUnloggedUsers(new Date(), stubLogger() as never);

        expect(notifyTimesheetReminderMock.mock.calls[0]![0].expected_hours).toBe(6);
    });

    it('falls back to the default threshold when settings has a non-finite value', async () => {
        // Defence: if settings is corrupt (NaN / Infinity), the job
        // should not propagate the bogus value into the email body.
        getOrInitSettingsMock.mockResolvedValueOnce({
            timesheet: { daily_warn_threshold_hours: NaN },
        });
        const user = makeUser();
        userFindMock.mockReturnValueOnce({ select: () => Promise.resolve([user]) });
        leaveRequestFindMock.mockReturnValueOnce({ distinct: () => Promise.resolve([]) });
        userIdsWithEntriesOnMock.mockResolvedValueOnce(new Set<string>());

        await job.remindUnloggedUsers(new Date(), stubLogger() as never);

        const expected = notifyTimesheetReminderMock.mock.calls[0]![0].expected_hours;
        // The fallback constant — pin that we got SOME finite number.
        expect(Number.isFinite(expected)).toBe(true);
        expect(expected).toBeGreaterThan(0);
    });

    it('summary counts every bucket honestly across a mixed cohort', async () => {
        // 4 users: 1 on leave, 1 already-logged, 2 to be notified.
        // The summary is the only audit-row signal ops have, so its
        // counts MUST be accurate.
        const onLeave = makeUser();
        const alreadyLogged = makeUser();
        const notify1 = makeUser();
        const notify2 = makeUser();
        userFindMock.mockReturnValueOnce({
            select: () => Promise.resolve([onLeave, alreadyLogged, notify1, notify2]),
        });
        leaveRequestFindMock.mockReturnValueOnce({
            distinct: () => Promise.resolve([onLeave._id]),
        });
        userIdsWithEntriesOnMock.mockResolvedValueOnce(new Set<string>([String(alreadyLogged._id)]));

        const summary = await job.remindUnloggedUsers(new Date(), stubLogger() as never);

        expect(summary.headcount).toBe(4);
        expect(summary.on_leave).toBe(1);
        expect(summary.already_logged).toBe(1);
        expect(summary.notified).toBe(2);
    });

    it('emits a single info-level log line carrying the full summary', async () => {
        // Operators rely on this single line to spot regressions
        // (e.g. notified=0 when headcount=50 means something broke).
        userFindMock.mockReturnValueOnce({ select: () => Promise.resolve([]) });
        leaveRequestFindMock.mockReturnValueOnce({ distinct: () => Promise.resolve([]) });
        userIdsWithEntriesOnMock.mockResolvedValueOnce(new Set<string>());

        const log = stubLogger();
        await job.remindUnloggedUsers(new Date(), log as never);

        expect(log.info).toHaveBeenCalledTimes(1);
        const [summary] = log.info.mock.calls[0]!;
        expect(summary).toMatchObject({
            headcount: 0,
            on_leave: 0,
            already_logged: 0,
            notified: 0,
        });
    });
});

import { Types } from 'mongoose';

import { User, type UserDocument } from '../models/user.model.js';
import { AttendanceRecord } from '../models/attendance-record.model.js';
import { Holiday } from '../models/holiday.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import { JOB_NAMES, attendanceCheckinNudgeRunKey, attendanceCheckoutReminderRunKey } from '../constants/jobs.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';
import { getOrInitSettings } from '../services/settings.service.js';
import { slackContextFrom, postOrUpdateSlackMessage, type SlackContext } from '../utils/slack.js';
import { resolveSlackIdByEmail, fetchSlackAvatarUrl } from '../services/slack-user-mapping.service.js';
import { buildCheckinNudgeMessage, buildCheckoutReminderMessage } from '../utils/slack-attendance-blocks.js';

/**
 * Slack attendance nudges (spec: 2026-06-16-slack-attendance-home-design).
 *
 *  - Check-in nudge (11:00 IST default): DM eligible employees a Check In
 *    button. Eligible = active internal user, today is a working day (not
 *    weekend/holiday) and they're not on approved leave, and they have no
 *    check-in yet today.
 *  - Checkout reminder (20:00 IST default): DM anyone with an OPEN segment
 *    today a Check Out button.
 *
 * Eager mapping: a user without `slack_user_id` is resolved by email via
 * users.lookupByEmail and the id persisted, so new employees are reachable
 * from day one. Every Slack call is non-throwing — one failure logs and
 * the loop continues. Both gated by JOBS_ENABLED + slack.enabled +
 * attendance_nudges.enabled.
 */

const todayIst = (now: Date): string => dayjs(now).tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

interface CheckinNudgeSummary extends Record<string, unknown> {
    target_date: string;
    skipped?: boolean;
    non_working_day?: boolean;
    headcount: number;
    on_leave: number;
    already_checked_in: number;
    unmapped: number;
    notified: number;
}

interface CheckoutReminderSummary extends Record<string, unknown> {
    target_date: string;
    skipped?: boolean;
    open_segments: number;
    unmapped: number;
    reminded: number;
}

const loadInternalUsers = (): Promise<UserDocument[]> =>
    User.find({
        status: USER_STATUSES.ACTIVE,
        role: { $in: [ROLES.ADMIN, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE] },
    }).select('_id email full_name role slack_user_id slack_avatar_url');

const onLeaveUserIds = async (localDate: string): Promise<Set<string>> => {
    const rows = await LeaveRequest.find({
        status: LEAVE_REQUEST_STATUSES.APPROVED,
        start_date: { $lte: localDate },
        end_date: { $gte: localDate },
    }).distinct('user_id');
    return new Set(rows.map((id) => String(id)));
};

const checkedInUserIds = async (localDate: string): Promise<Set<string>> => {
    const rows = await AttendanceRecord.find({
        local_date: localDate,
        check_in: { $ne: null },
    }).distinct('user_id');
    return new Set(rows.map((id) => String(id)));
};

const slackIdFor = async (
    user: { _id: Types.ObjectId; email: string; slack_user_id?: string | null; slack_avatar_url?: string | null },
    botToken: string
): Promise<string | null> => {
    if (user.slack_user_id) {
        // Backfill the avatar once for users mapped before the cache existed.
        if (!user.slack_avatar_url) {
            const avatarUrl = await fetchSlackAvatarUrl(user.slack_user_id, botToken);
            if (avatarUrl) await User.findByIdAndUpdate(user._id, { slack_avatar_url: avatarUrl });
        }
        return user.slack_user_id;
    }
    const resolved = await resolveSlackIdByEmail(user.email, botToken);
    if (resolved) {
        await User.findByIdAndUpdate(user._id, {
            slack_user_id: resolved.slackId,
            ...(resolved.avatarUrl ? { slack_avatar_url: resolved.avatarUrl } : {}),
        });
    }
    return resolved?.slackId ?? null;
};

const loadSlackContext = async (): Promise<SlackContext | null> => {
    const settings = await getOrInitSettings();
    if (!settings.slack?.enabled || !settings.slack?.attendance_nudges?.enabled) return null;
    return slackContextFrom(settings.slack);
};

const isWorkingDay = async (localDate: string): Promise<boolean> => {
    const settings = await getOrInitSettings();
    const workingDays = settings.work_schedule?.working_days ?? [1, 2, 3, 4, 5];
    const dow = dayjs.tz(localDate, DEFAULT_TIMEZONE).day();
    if (!workingDays.includes(dow)) return false;
    const holiday = await Holiday.exists({ date: localDate });
    return !holiday;
};

export const sendCheckinNudges = async (now: Date, log: JobContext['log']): Promise<CheckinNudgeSummary> => {
    const targetDate = todayIst(now);
    const summary: CheckinNudgeSummary = {
        target_date: targetDate,
        headcount: 0,
        on_leave: 0,
        already_checked_in: 0,
        unmapped: 0,
        notified: 0,
    };

    const ctx = await loadSlackContext();
    if (!ctx) {
        summary.skipped = true;
        log.info(summary, 'Slack check-in nudge skipped — disabled or unconfigured');
        return summary;
    }
    if (!(await isWorkingDay(targetDate))) {
        summary.non_working_day = true;
        log.info(summary, 'Slack check-in nudge skipped — non-working day');
        return summary;
    }

    const [users, onLeave, checkedIn] = await Promise.all([
        loadInternalUsers(),
        onLeaveUserIds(targetDate),
        checkedInUserIds(targetDate),
    ]);
    summary.headcount = users.length;

    for (const u of users) {
        const idStr = u._id.toString();
        if (onLeave.has(idStr)) {
            summary.on_leave += 1;
            continue;
        }
        if (checkedIn.has(idStr)) {
            summary.already_checked_in += 1;
            continue;
        }
        const slackId = await slackIdFor(u, ctx.botToken!);
        if (!slackId) {
            summary.unmapped += 1;
            continue;
        }
        const msg = buildCheckinNudgeMessage(u.full_name ?? 'there');
        await postOrUpdateSlackMessage(ctx, {
            channel: slackId,
            blocks: msg.blocks,
            text: msg.text,
            existing: null,
            context: 'attendance-checkin-nudge',
        });
        summary.notified += 1;
    }

    log.info(summary, 'Slack check-in nudge finished');
    return summary;
};

export const sendCheckoutReminders = async (now: Date, log: JobContext['log']): Promise<CheckoutReminderSummary> => {
    const targetDate = todayIst(now);
    const summary: CheckoutReminderSummary = {
        target_date: targetDate,
        open_segments: 0,
        unmapped: 0,
        reminded: 0,
    };

    const ctx = await loadSlackContext();
    if (!ctx) {
        summary.skipped = true;
        log.info(summary, 'Slack checkout reminder skipped — disabled or unconfigured');
        return summary;
    }

    const records = await AttendanceRecord.find({
        local_date: targetDate,
        check_in: { $ne: null },
        check_out: null,
    }).select('user_id segments');
    summary.open_segments = records.length;
    if (records.length === 0) {
        log.info(summary, 'Slack checkout reminder finished — nobody open');
        return summary;
    }

    const userIds = records.map((r) => r.user_id as Types.ObjectId);
    const users = await User.find({ _id: { $in: userIds }, status: USER_STATUSES.ACTIVE }).select(
        '_id email full_name slack_user_id slack_avatar_url'
    );
    const userById = new Map(users.map((u) => [u._id.toString(), u]));

    for (const rec of records) {
        const user = userById.get(rec.user_id.toString());
        if (!user) continue;
        const slackId = await slackIdFor(user, ctx.botToken!);
        if (!slackId) {
            summary.unmapped += 1;
            continue;
        }
        const segs = (rec.segments ?? []) as Array<{ check_in?: { time?: Date } }>;
        const lastIn = segs.length > 0 ? segs[segs.length - 1]?.check_in?.time : undefined;
        const checkedInAt = lastIn instanceof Date ? lastIn : new Date();
        const msg = buildCheckoutReminderMessage(checkedInAt);
        await postOrUpdateSlackMessage(ctx, {
            channel: slackId,
            blocks: msg.blocks,
            text: msg.text,
            existing: null,
            context: 'attendance-checkout-reminder',
        });
        summary.reminded += 1;
    }

    log.info(summary, 'Slack checkout reminder finished');
    return summary;
};

export const runAttendanceCheckinNudge = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = attendanceCheckinNudgeRunKey(now);
    return runJob(JOB_NAMES.ATTENDANCE_CHECKIN_NUDGE, runKey, async (ctx) => sendCheckinNudges(now, ctx.log), opts);
};

export const runAttendanceCheckoutReminder = (
    now: Date = new Date(),
    opts: RunJobOptions = {}
): Promise<RunJobResult> => {
    const runKey = attendanceCheckoutReminderRunKey(now);
    return runJob(
        JOB_NAMES.ATTENDANCE_CHECKOUT_REMINDER,
        runKey,
        async (ctx) => sendCheckoutReminders(now, ctx.log),
        opts
    );
};

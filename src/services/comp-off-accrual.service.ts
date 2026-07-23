import { Types } from 'mongoose';

import { CompOffLedger } from '../models/comp-off-ledger.model.js';
import { Holiday } from '../models/holiday.model.js';
import { Notification } from '../models/notification.model.js';
import { Project } from '../models/project.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { User } from '../models/user.model.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { COMP_OFF_SOURCES } from '../constants/leave.js';
import { NOTIFICATION_TYPES } from '../constants/notification.js';
import { ROLES } from '../constants/roles.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { weekdayOvertimeGrantDays, weekendGrantDays } from '../utils/comp-off-accrual.js';
import logger from '../utils/logger.js';
import { withTransaction } from '../utils/with-transaction.js';
import { recordSystemAudit } from './audit.service.js';
import { compOffExpiryFrom, createEarnedLot, resyncCompOff } from './comp-off.service.js';
import { getOrInitSettings } from './settings.service.js';

/**
 * Automatic comp-off accrual from BILLABLE TIMESHEET hours — see
 * docs/superpowers/specs/2026-07-23-comp-off-billable-accrual-expiry-design.md.
 *
 * Each (user, day) settles to ONE comp-off "lot" chosen by day type:
 *  - weekend/holiday → full shift = 1 day, half = 0.5 (against billable minutes)
 *  - weekday         → OT = billable − scheduled; every half-`comp_off_hours_per_day`
 *                      of OT = 0.5 day (NO carry across days)
 * The grant is attributed to the day's TOP billable project (name snapshotted).
 *
 * `settleCompOffForDay` is IDEMPOTENT — it computes the target and converges the
 * per-day lot to it (up fully, down only by the still-unused portion). Runs
 * nightly for the day that just closed AND on any timesheet edit for a past
 * day. Only days strictly before today settle (today is still being worked).
 * Gated on `settings.leave_policy.comp_off_auto_accrual_enabled` (off by default).
 */

export type SettleReason = 'granted' | 'unchanged' | 'disabled' | 'not_closed' | 'ineligible';

export interface SettleResult {
    user_id: string;
    date: string;
    reason: SettleReason;
    days: number; // the lot's days after settling
    delta: number; // change applied (can be negative)
    project_name: string | null;
}

interface BillableDay {
    totalBillableMinutes: number;
    topProjectId: Types.ObjectId | null;
}

/** Sum a user's billable timesheet minutes for a day + the top billable project. */
const readBillableDay = async (userId: Types.ObjectId, date: string): Promise<BillableDay> => {
    const rows = await TimesheetEntry.aggregate<{ _id: Types.ObjectId | null; minutes: number }>([
        { $match: { user_id: userId, local_date: date } },
        { $group: { _id: '$project_id', minutes: { $sum: '$billable_total_minutes' } } },
    ]);
    const totalBillableMinutes = rows.reduce((a, r) => a + (r.minutes ?? 0), 0);
    const topProjectId =
        rows.filter((r) => r._id && r.minutes > 0).sort((a, b) => b.minutes - a.minutes)[0]?._id ?? null;
    return { totalBillableMinutes, topProjectId };
};

const istToday = (): string => dayjs().tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD');

/**
 * Settle one (user, day): compute the target comp-off from the day's billable
 * timesheets and converge the per-day lot to it. Idempotent + safe to re-run.
 */
export const settleCompOffForDay = async (userId: Types.ObjectId, date: string): Promise<SettleResult> => {
    const base: SettleResult = {
        user_id: userId.toString(),
        date,
        reason: 'unchanged',
        days: 0,
        delta: 0,
        project_name: null,
    };

    const settings = await getOrInitSettings();
    if (settings.leave_policy.comp_off_auto_accrual_enabled !== true) return { ...base, reason: 'disabled' };
    // Only settle CLOSED days — today is still being worked; it settles tonight.
    if (date >= istToday()) return { ...base, reason: 'not_closed' };

    const user = await User.findById(userId).select('role');
    if (!user || user.role === ROLES.CLIENT) return { ...base, reason: 'ineligible' };

    const { totalBillableMinutes, topProjectId } = await readBillableDay(userId, date);

    // Day type (a property of the date).
    const workingDays = settings.work_schedule.working_days ?? [1, 2, 3, 4, 5];
    const dow = dayjs.tz(date, DEFAULT_TIMEZONE).day();
    const isHoliday = Boolean(await Holiday.exists({ date }));
    const isWeekend = !workingDays.includes(dow);
    const nonWorking: 'weekend' | 'holiday' | null = isHoliday ? 'holiday' : isWeekend ? 'weekend' : null;

    const fullShiftMinutes = (settings.work_schedule.daily_expected_hours ?? 8) * 60;
    const thresholdMinutes = (settings.leave_policy.comp_off_hours_per_day ?? 8) * 60;
    const targetDays = nonWorking
        ? weekendGrantDays(totalBillableMinutes, fullShiftMinutes)
        : weekdayOvertimeGrantDays(totalBillableMinutes, fullShiftMinutes, thresholdMinutes);

    // Resolve top project name (snapshot).
    let projectName: string | null = null;
    if (topProjectId) {
        const p = await Project.findById(topProjectId).select('name').lean<{ name: string } | null>();
        projectName = p?.name ?? null;
    }
    const rule = nonWorking ?? 'overtime';
    const remarks = `Auto-accrued: ${rule} on ${date}`;

    const existing = await CompOffLedger.findOne({
        user_id: userId,
        source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE,
        source_date: date,
    });

    const delta = await withTransaction(async (session) => {
        if (!existing) {
            if (targetDays <= 0) return 0; // nothing to grant, no lot
            await createEarnedLot(
                {
                    user_id: userId,
                    days: targetDays,
                    source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE,
                    source_date: date,
                    project_id: topProjectId,
                    project_name: projectName,
                    source_minutes: totalBillableMinutes,
                    remarks,
                    expires_at: compOffExpiryFrom(date),
                },
                session
            );
            await resyncCompOff(userId, session);
            return targetDays;
        }

        if (existing.expired) return 0; // a fully-lapsed lot is left as history
        const consumed = Number((existing.days - existing.remaining_days).toFixed(2));
        // Never claw back below what's already been used.
        const newDays = Math.max(targetDays, consumed);
        const priorDays = existing.days;
        const newRemaining = Number((newDays - consumed).toFixed(2));

        if (newDays <= 0) {
            // Target dropped to 0 and nothing was consumed → remove the empty lot.
            await existing.deleteOne(session ? { session } : {});
            await resyncCompOff(userId, session);
            return -priorDays;
        }

        existing.days = newDays;
        existing.remaining_days = newRemaining;
        existing.project_id = topProjectId;
        existing.project_name = projectName;
        existing.source_minutes = totalBillableMinutes;
        existing.remarks = remarks;
        existing.expires_at = compOffExpiryFrom(date);
        await (session ? existing.save({ session }) : existing.save());
        await resyncCompOff(userId, session);
        return Number((newDays - priorDays).toFixed(2));
    });

    if (delta > 0) {
        await notifyAccrual(userId, delta, rule, date).catch(() => undefined);
    }
    return {
        user_id: userId.toString(),
        date,
        reason: delta !== 0 ? 'granted' : 'unchanged',
        days: targetDays,
        delta,
        project_name: projectName,
    };
};

/** Best-effort audit + in-app notification for a positive grant. Never throws. */
const notifyAccrual = async (userId: Types.ObjectId, days: number, rule: string, date: string): Promise<void> => {
    try {
        await recordSystemAudit({
            action: AUDIT_ACTIONS.COMP_OFF_ACCRUE,
            target: { kind: AUDIT_TARGET_KINDS.COMP_OFF_LEDGER, id: userId },
            metadata: { user_id: userId.toString(), source_date: date, rule, days },
        });
        await Notification.create({
            user_id: userId,
            type: NOTIFICATION_TYPES.SYSTEM,
            title: 'Comp-off earned',
            body: `You earned ${days} comp-off day${days === 1 ? '' : 's'} for ${rule} work on ${date}.`,
            link_url: '/comp-off',
            related_entity: null,
            is_read: false,
            read_at: null,
        });
    } catch (err) {
        logger.warn({ err, user_id: userId.toString() }, 'comp-off accrual side-effect failed');
    }
};

export type CompOffAccrualResult = {
    target_date: string;
    enabled: boolean;
    processed: number;
    granted_users: number;
    granted_days: number;
};

/**
 * Nightly: settle comp-off for every user who logged a timesheet on `targetDate`.
 * No-op (`enabled: false`) unless the setting is on. Idempotent — re-runs and
 * later timesheet edits converge the same per-day lots.
 */
export const accrueCompOffForDay = async (targetDate: string): Promise<CompOffAccrualResult> => {
    const settings = await getOrInitSettings();
    const enabled = settings.leave_policy.comp_off_auto_accrual_enabled === true;
    const result: CompOffAccrualResult = {
        target_date: targetDate,
        enabled,
        processed: 0,
        granted_users: 0,
        granted_days: 0,
    };
    if (!enabled) return result;

    const userIds = await TimesheetEntry.distinct('user_id', { local_date: targetDate });
    for (const uid of userIds) {
        result.processed += 1;
        const outcome = await settleCompOffForDay(uid as Types.ObjectId, targetDate);
        if (outcome.delta > 0) {
            result.granted_users += 1;
            result.granted_days = Number((result.granted_days + outcome.delta).toFixed(2));
        }
    }

    if (result.granted_days > 0) logger.info(result, 'Comp-off accrual granted');
    return result;
};

import { Types } from 'mongoose';

import { CompOffAccrualDay } from '../models/comp-off-accrual-day.model.js';
import { type CompOffContribution } from '../models/comp-off-ledger.model.js';
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
import { overtimeBank, weekendGrantDays } from '../utils/comp-off-accrual.js';
import { REALTIME_TOPICS } from '../constants/realtime.js';
import { publish } from './realtime.service.js';
import logger from '../utils/logger.js';
import { withTransaction } from '../utils/with-transaction.js';
import { recordSystemAudit } from './audit.service.js';
import { compOffExpiryFrom, createEarnedLot, resyncCompOff } from './comp-off.service.js';
import { getOrInitSettings } from './settings.service.js';

/**
 * Automatic comp-off accrual from BILLABLE TIMESHEET hours — carry-over bank
 * model (docs/superpowers/specs/2026-07-23-comp-off-billable-accrual-expiry-design.md).
 *
 * FORWARD-ONLY + HELD once earned:
 *  - Each closed day is folded into the user's overtime bank exactly once
 *    (guarded by a `comp_off_accrual_days` marker). Editing that timesheet
 *    later does NOT re-accrue.
 *  - Weekday overtime (billable − scheduled) accumulates ACROSS days; every
 *    half-`comp_off_hours_per_day` banked earns 0.5 comp-off, the remainder
 *    carries. When the bank tips over a step, the accumulated (day, project,
 *    minutes) slices are attached to the minted lot's `contributions` (the
 *    accordion) — so a day earned from 2h on Project A + 6h on Project B shows
 *    both.
 *  - Weekend/holiday work grants immediately (full shift = 1, half = 0.5),
 *    attributed to that day's top project.
 *
 * Gated on `settings.leave_policy.comp_off_auto_accrual_enabled` (off default).
 */

export type AccrualReason = 'granted' | 'banked' | 'disabled' | 'not_closed' | 'ineligible' | 'already_processed';

export interface AccrualResult {
    user_id: string;
    date: string;
    reason: AccrualReason;
    granted_days: number;
    banked_minutes: number;
}

/** Sum a user's billable minutes for a day + the top billable project. */
const readBillableDay = async (
    userId: Types.ObjectId,
    date: string
): Promise<{ totalBillableMinutes: number; topProjectId: Types.ObjectId | null }> => {
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

const resolveProjectName = async (projectId: Types.ObjectId | null): Promise<string | null> => {
    if (!projectId) return null;
    const p = await Project.findById(projectId).select('name').lean<{ name: string } | null>();
    return p?.name ?? null;
};

const sumMinutes = (rows: CompOffContribution[]): number => rows.reduce((a, r) => a + r.minutes, 0);

/**
 * Fold ONE closed day into a user's comp-off (forward-only, once). Returns what
 * happened. Safe to call from the nightly job; the marker makes re-runs no-ops.
 */
export const processCompOffForDay = async (userId: Types.ObjectId, date: string): Promise<AccrualResult> => {
    const base: AccrualResult = {
        user_id: userId.toString(),
        date,
        reason: 'banked',
        granted_days: 0,
        banked_minutes: 0,
    };

    const settings = await getOrInitSettings();
    if (settings.leave_policy.comp_off_auto_accrual_enabled !== true) return { ...base, reason: 'disabled' };
    if (date >= istToday()) return { ...base, reason: 'not_closed' };

    const user = await User.findById(userId).select(
        'role comp_off_overtime_bank_minutes comp_off_pending_contributions'
    );
    if (!user || user.role === ROLES.CLIENT) return { ...base, reason: 'ineligible' };

    // Idempotency: this day already folded into the bank → do nothing (HELD).
    if (await CompOffAccrualDay.exists({ user_id: userId, local_date: date })) {
        return { ...base, reason: 'already_processed' };
    }

    const { totalBillableMinutes, topProjectId } = await readBillableDay(userId, date);
    const projectName = await resolveProjectName(topProjectId);

    const workingDays = settings.work_schedule.working_days ?? [1, 2, 3, 4, 5];
    const dow = dayjs.tz(date, DEFAULT_TIMEZONE).day();
    const isHoliday = Boolean(await Holiday.exists({ date }));
    const isWeekend = !workingDays.includes(dow);
    const nonWorking: 'weekend' | 'holiday' | null = isHoliday ? 'holiday' : isWeekend ? 'weekend' : null;

    const fullShiftMinutes = (settings.work_schedule.daily_expected_hours ?? 8) * 60;
    const thresholdMinutes = (settings.leave_policy.comp_off_hours_per_day ?? 8) * 60;
    const halfStep = Math.max(1, Math.round(thresholdMinutes / 2)); // minutes per 0.5 comp-off day

    let grantedDays = 0;
    let bankedAfter = user.comp_off_overtime_bank_minutes ?? 0;

    await withTransaction(async (session) => {
        if (nonWorking) {
            // Weekend/holiday → immediate grant, single-day provenance. Bank untouched.
            const days = weekendGrantDays(totalBillableMinutes, fullShiftMinutes);
            if (days > 0) {
                await mintLot(
                    userId,
                    days,
                    date,
                    totalBillableMinutes,
                    [{ date, project_id: topProjectId, project_name: projectName, minutes: totalBillableMinutes }],
                    session
                );
                grantedDays = days;
            }
        } else {
            // Weekday → bank the overtime; mint whole 0.5-steps when it tips over.
            const dayOt = Math.max(0, totalBillableMinutes - fullShiftMinutes);
            const pending: CompOffContribution[] = [...(user.comp_off_pending_contributions ?? [])];
            if (dayOt > 0) {
                pending.push({ date, project_id: topProjectId, project_name: projectName, minutes: dayOt });
            }
            const banked = overtimeBank(user.comp_off_overtime_bank_minutes ?? 0, dayOt, halfStep);
            const days = banked.grantDays * 0.5; // half-steps → comp-off days

            if (days > 0) {
                // Attach the accumulated slices to the minted lot; carry the
                // sub-step remainder as bare minutes (its provenance rolls into
                // the next grant along with future days).
                await mintLot(userId, days, date, sumMinutes(pending), pending, session);
                grantedDays = days;
                await User.updateOne(
                    { _id: userId },
                    {
                        $set: {
                            comp_off_overtime_bank_minutes: banked.newBankMinutes,
                            comp_off_pending_contributions: [],
                        },
                    },
                    session ? { session } : {}
                );
            } else {
                await User.updateOne(
                    { _id: userId },
                    {
                        $set: {
                            comp_off_overtime_bank_minutes: banked.newBankMinutes,
                            comp_off_pending_contributions: pending,
                        },
                    },
                    session ? { session } : {}
                );
            }
            bankedAfter = banked.newBankMinutes;
        }

        // Mark the day processed (idempotency) — same txn as the grant/bank.
        await CompOffAccrualDay.create(
            [{ user_id: userId, local_date: date, overtime_minutes: totalBillableMinutes, granted_days: grantedDays }],
            session ? { session } : {}
        );

        if (grantedDays > 0) await resyncCompOff(userId, session);
    });

    if (grantedDays > 0) {
        await notifyAccrual(userId, grantedDays, nonWorking ?? 'overtime', date).catch(() => undefined);
    }
    return {
        user_id: userId.toString(),
        date,
        reason: grantedDays > 0 ? 'granted' : 'banked',
        granted_days: grantedDays,
        banked_minutes: bankedAfter,
    };
};

/** Create an earned comp-off lot from accrual with its contribution slices. */
const mintLot = async (
    userId: Types.ObjectId,
    days: number,
    tipDate: string,
    sourceMinutes: number,
    contributions: CompOffContribution[],
    session: import('mongoose').ClientSession | null | undefined
): Promise<void> => {
    const top = [...contributions].sort((a, b) => b.minutes - a.minutes)[0];
    await createEarnedLot(
        {
            user_id: userId,
            days,
            source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE,
            source_date: tipDate,
            project_id: top?.project_id ?? null,
            project_name: top?.project_name ?? null,
            source_minutes: sourceMinutes,
            contributions,
            remarks: `Auto-accrued from ${contributions.length} day(s) of billable overtime`,
            expires_at: compOffExpiryFrom(tipDate),
        },
        session
    );
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
            body: `You earned ${days} comp-off day${days === 1 ? '' : 's'} from ${rule} work.`,
            link_url: '/comp-off',
            related_entity: null,
            is_read: false,
            read_at: null,
        });
        // Cron-driven, so there's no HTTP request for the realtime-emit
        // middleware to derive a topic from — publish explicitly or the
        // bell won't move until the fallback poll.
        publish([REALTIME_TOPICS.NOTIFICATIONS, REALTIME_TOPICS.COMP_OFF]);
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
 * Nightly: fold `targetDate` into every user's bank (who logged a timesheet that
 * day). No-op if disabled. Forward-only + idempotent via the per-day marker.
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
        const outcome = await processCompOffForDay(uid as Types.ObjectId, targetDate);
        if (outcome.granted_days > 0) {
            result.granted_users += 1;
            result.granted_days = Number((result.granted_days + outcome.granted_days).toFixed(2));
        }
    }

    if (result.granted_days > 0) logger.info(result, 'Comp-off accrual granted');
    return result;
};

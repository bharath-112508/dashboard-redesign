import { Types } from 'mongoose';

import { AttendanceRecord, type AttendanceRecordDocument } from '../models/attendance-record.model.js';
import { CompOffLedger } from '../models/comp-off-ledger.model.js';
import { Holiday } from '../models/holiday.model.js';
import { Notification } from '../models/notification.model.js';
import { User } from '../models/user.model.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { COMP_OFF_SOURCES, COMP_OFF_TYPES } from '../constants/leave.js';
import { NOTIFICATION_TYPES } from '../constants/notification.js';
import { ROLES } from '../constants/roles.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { overtimeBank, weekendGrantDays } from '../utils/comp-off-accrual.js';
import logger from '../utils/logger.js';
import { withTransaction } from '../utils/with-transaction.js';
import { recordSystemAudit } from './audit.service.js';
import { syncLeaveBalanceForCompOff } from './comp-off.service.js';
import { getOrInitSettings } from './settings.service.js';

/**
 * Automatic comp-off accrual — see
 * docs/superpowers/specs/2026-07-21-comp-off-auto-accrual-design.md.
 *
 * For a finalized day (the finalizer's "yesterday" IST), each user's record
 * earns comp-off by ONE rule chosen by day type:
 *  - weekend/holiday work → full shift = 1 day, half shift = 0.5 (raw worked)
 *  - normal working day    → overtime accumulates in a per-user bank; every
 *    `comp_off_hours_per_day` (default 8h) earned = 1 comp-off, remainder
 *    carries.
 *
 * Idempotent: each record is stamped `comp_off_accrued` inside the same
 * transaction as the grant/bank write, so re-runs never double-grant. Gated
 * on `settings.leave_policy.comp_off_auto_accrual_enabled` (off by default).
 */

export type CompOffAccrualResult = {
    target_date: string;
    enabled: boolean;
    processed: number;
    granted_users: number;
    granted_days: number;
};

type NonWorkingLabel = 'weekend' | 'holiday';
type RuleLabel = NonWorkingLabel | 'overtime';

interface DayContext {
    targetDate: string;
    nonWorkingLabel: NonWorkingLabel | null; // null ⇒ a normal working day
    fullShiftMinutes: number;
    thresholdMinutes: number;
}

interface RecordOutcome {
    grantDays: number;
    ledgerId: Types.ObjectId | null;
    balanceAfter: number;
    rule: RuleLabel;
}

/**
 * Process ONE attendance record atomically: read the user, compute the grant
 * (weekend or overtime-bank), write the ledger + balance + mirror + updated
 * bank, and stamp the record accrued — all in a single transaction so a crash
 * or re-run can never double-grant. Returns null if the record was skipped
 * (missing/ineligible user); it is still marked accrued so it isn't retried.
 */
const accrueOneRecord = async (rec: AttendanceRecordDocument, ctx: DayContext): Promise<RecordOutcome | null> =>
    withTransaction(async (session) => {
        const opt = session ? { session } : {};
        const markAccrued = () =>
            AttendanceRecord.updateOne({ _id: rec._id }, { $set: { comp_off_accrued: true } }, opt);

        const userQuery = User.findById(rec.user_id).select('role comp_off_balance comp_off_overtime_bank_minutes');
        const user = session ? await userQuery.session(session) : await userQuery;
        // Comp-off is a staff-only construct; a missing or client user just
        // gets its record marked so it isn't reprocessed.
        if (!user || user.role === ROLES.CLIENT) {
            await markAccrued();
            return null;
        }

        let grantDays: number;
        let newBankMinutes: number | null = null;
        let rule: RuleLabel;
        if (ctx.nonWorkingLabel) {
            grantDays = weekendGrantDays(rec.total_worked_minutes ?? 0, ctx.fullShiftMinutes);
            rule = ctx.nonWorkingLabel;
        } else {
            const banked = overtimeBank(
                user.comp_off_overtime_bank_minutes ?? 0,
                rec.overtime_minutes ?? 0,
                ctx.thresholdMinutes
            );
            grantDays = banked.grantDays;
            newBankMinutes = banked.newBankMinutes;
            rule = 'overtime';
        }

        let ledgerId: Types.ObjectId | null = null;
        let balanceAfter = user.comp_off_balance ?? 0;
        if (grantDays > 0) {
            const cas = await User.findOneAndUpdate(
                { _id: rec.user_id },
                { $inc: { comp_off_balance: grantDays } },
                { new: true, ...opt }
            );
            balanceAfter = cas?.comp_off_balance ?? balanceAfter + grantDays;
            const payload = {
                user_id: rec.user_id,
                type: COMP_OFF_TYPES.EARNED,
                days: grantDays,
                source_type: COMP_OFF_SOURCES.ATTENDANCE_OVERTIME,
                source_ref_id: rec._id,
                remarks: `Auto-accrued: ${rule} work on ${ctx.targetDate}`,
                created_by: null,
            };
            const ledger = session
                ? (await CompOffLedger.create([payload], { session }))[0]!
                : await CompOffLedger.create(payload);
            ledgerId = ledger._id as Types.ObjectId;
            await syncLeaveBalanceForCompOff(rec.user_id, balanceAfter, session);
        }

        // Persist the new overtime bank (working-day path only) + stamp the
        // record accrued — atomic with the grant above.
        if (newBankMinutes !== null) {
            await User.updateOne(
                { _id: rec.user_id },
                { $set: { comp_off_overtime_bank_minutes: newBankMinutes } },
                opt
            );
        }
        await markAccrued();

        return { grantDays, ledgerId, balanceAfter, rule };
    });

/** Best-effort system audit + in-app notification for a grant. Never throws. */
const recordGrantSideEffects = async (
    rec: AttendanceRecordDocument,
    outcome: RecordOutcome,
    targetDate: string
): Promise<void> => {
    try {
        if (outcome.ledgerId) {
            await recordSystemAudit({
                action: AUDIT_ACTIONS.COMP_OFF_ACCRUE,
                target: { kind: AUDIT_TARGET_KINDS.COMP_OFF_LEDGER, id: outcome.ledgerId },
                after: { balance: outcome.balanceAfter },
                metadata: {
                    user_id: rec.user_id.toString(),
                    source_date: targetDate,
                    rule: outcome.rule,
                    days: outcome.grantDays,
                },
            });
        }
        await Notification.create({
            user_id: rec.user_id,
            type: NOTIFICATION_TYPES.SYSTEM,
            title: 'Comp-off earned',
            body: `You earned ${outcome.grantDays} comp-off day${
                outcome.grantDays === 1 ? '' : 's'
            } for ${outcome.rule} work on ${targetDate}.`,
            link_url: '/comp-off',
            related_entity: null,
            is_read: false,
            read_at: null,
        });
    } catch (err) {
        logger.warn({ err, user_id: rec.user_id.toString() }, 'comp-off accrual side-effect failed');
    }
};

/**
 * Accrue comp-off for every eligible attendance record on `targetDate`.
 * No-op (returns `enabled: false`) unless the setting is on. Processes only
 * un-accrued records with worked time, so it never back-fills history and is
 * safe to re-run.
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

    const fullShiftMinutes = (settings.work_schedule.daily_expected_hours ?? 8) * 60;
    const thresholdMinutes = (settings.leave_policy.comp_off_hours_per_day ?? 8) * 60;
    const workingDays = settings.work_schedule.working_days ?? [1, 2, 3, 4, 5];

    // Day type is a property of the date, not the user.
    const dow = dayjs.tz(targetDate, DEFAULT_TIMEZONE).day(); // 0=Sun … 6=Sat
    const isHoliday = Boolean(await Holiday.exists({ date: targetDate }));
    const isWeekend = !workingDays.includes(dow);
    const nonWorkingLabel: NonWorkingLabel | null = isHoliday ? 'holiday' : isWeekend ? 'weekend' : null;

    const ctx: DayContext = { targetDate, nonWorkingLabel, fullShiftMinutes, thresholdMinutes };

    const records = await AttendanceRecord.find({
        local_date: targetDate,
        comp_off_accrued: { $ne: true },
        total_worked_minutes: { $gt: 0 },
    });

    for (const rec of records) {
        result.processed += 1;
        const outcome = await accrueOneRecord(rec, ctx);
        if (outcome && outcome.grantDays > 0) {
            result.granted_users += 1;
            result.granted_days += outcome.grantDays;
            await recordGrantSideEffects(rec, outcome, targetDate);
        }
    }

    if (result.granted_days > 0) {
        logger.info(result, 'Comp-off accrual granted');
    }
    return result;
};

import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { LeaveType, type LeaveTypeDocument } from '../models/leave-type.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveBalance, recomputeAvailable } from '../models/leave-balance.model.js';
import { SlMonthlyForfeiture } from '../models/sl-monthly-forfeiture.model.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { LEAVE_CODES, LEAVE_REQUEST_STATUSES, SL_FORFEITURE_REASONS } from '../constants/leave.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { JOB_NAMES, JOB_USER_BATCH_SIZE, slMonthlyForfeitureRunKey } from '../constants/jobs.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * 14.2 Monthly SL forfeiture (Plan §8 row 2, Data_Model §3.5).
 *
 * Last day of each month at 23:55 IST. For every active internal user, if
 * they used **0 SL** in the closing calendar month, decrement that month's
 * entitlement by `monthly_cap` (1 in v1) and write a `sl_monthly_forfeitures`
 * row. The forfeiture lowers `leave_balances.monthly_forfeited` (so
 * `available` shrinks) and is the same record the apply-time SL engine
 * already reads for "this month is exhausted".
 *
 * Idempotency:
 *  - **Run-key** is `YYYY-MM` of today (IST). Calling the job twice in the
 *    same month is a no-op via the `job_runs` unique index.
 *  - **Per-user dedupe** is enforced by the `(user_id, year, month)` unique
 *    index on `sl_monthly_forfeitures`. A duplicate insert raises E11000
 *    which we count as `already_forfeited` instead of erroring.
 *
 * Day-of-month gate:
 *  - The cron expression fires daily at 23:55 IST (because node-cron does
 *    not support the "last day" `L` token). The job no-ops unless `today`
 *    is the actual last day of the month — protecting against partial fires
 *    if you ever want to call it from a one-off script.
 */

const isLastDayOfMonth = (now: Date): boolean => {
    const d = dayjs(now).tz(DEFAULT_TIMEZONE);
    return d.date() === d.daysInMonth();
};

interface SlForfeitureSummary extends Record<string, unknown> {
    target_year: number;
    target_month: number;
    sl_type_id: string | null;
    monthly_cap: number;
    users_processed: number;
    forfeited_users: number;
    skipped_used_sl: number;
    already_forfeited: number;
    errors: number;
    skipped_not_last_day: boolean;
}

/**
 * Pure logic — exported for unit tests. The cron entry point wraps this
 * with the shared runner.
 */
export const forfeitSlForMonth = async (
    year: number,
    month: number, // 1..12
    log: JobContext['log']
): Promise<SlForfeitureSummary> => {
    const summary: SlForfeitureSummary = {
        target_year: year,
        target_month: month,
        sl_type_id: null,
        monthly_cap: 0,
        users_processed: 0,
        forfeited_users: 0,
        skipped_used_sl: 0,
        already_forfeited: 0,
        errors: 0,
        skipped_not_last_day: false,
    };

    // SL is the only Phase-1 leave type with `monthly_forfeiture = true`.
    // We still query by code so future opt-in types pick this up too.
    const slType: LeaveTypeDocument | null = await LeaveType.findOne({
        code: LEAVE_CODES.SL,
        is_active: true,
        monthly_forfeiture: true,
    });
    if (!slType || !slType.monthly_cap || slType.monthly_cap <= 0) {
        log.warn({ year, month }, 'SL forfeiture: no eligible SL leave type configured — skipping');
        return summary;
    }
    summary.sl_type_id = slType._id.toString();
    summary.monthly_cap = slType.monthly_cap;

    // Pre-compute the set of users who used at least 1 SL day in the target
    // month. Pending SL counts the same as approved — once it's reserved the
    // monthly slot is claimed (the apply-engine guards on this same fact).
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = dayjs.tz(monthStart, DEFAULT_TIMEZONE).endOf('month').format('YYYY-MM-DD');
    const slConsumers = (await LeaveRequest.find({
        status: { $in: [LEAVE_REQUEST_STATUSES.APPROVED, LEAVE_REQUEST_STATUSES.PENDING] },
        'leave_segments.leave_type_id': slType._id,
        'leave_segments.year': year,
        start_date: { $gte: monthStart, $lte: monthEnd },
    }).select({ user_id: 1, _id: 0 })) as unknown as { user_id: Types.ObjectId }[];
    const usedSet = new Set(slConsumers.map((r) => r.user_id.toString()));

    const cursor = User.find({
        status: USER_STATUSES.ACTIVE,
        role: { $ne: ROLES.CLIENT },
    })
        .select({ _id: 1 })
        .batchSize(JOB_USER_BATCH_SIZE)
        .cursor();

    for await (const u of cursor) {
        summary.users_processed += 1;

        if (usedSet.has(u._id.toString())) {
            summary.skipped_used_sl += 1;
            continue;
        }

        try {
            const forfeitDays = slType.monthly_cap;

            // Insert the forfeiture row first — the unique index is what makes
            // the job idempotent. If we already forfeited this month for this
            // user (manual trigger / replay), E11000 short-circuits.
            try {
                await SlMonthlyForfeiture.create({
                    user_id: u._id,
                    year,
                    month,
                    forfeited_days: forfeitDays,
                    reason: SL_FORFEITURE_REASONS.UNUSED_MONTHLY_ALLOCATION,
                    run_id: `${JOB_NAMES.SL_MONTHLY_FORFEITURE}:${year}-${String(month).padStart(2, '0')}`,
                    applied_at: new Date(),
                });
            } catch (err) {
                if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
                    summary.already_forfeited += 1;
                    continue;
                }
                throw err;
            }

            // Reflect the forfeiture on the user's SL balance row for this
            // year so `available` shrinks and the dashboard / `/leave-balances/me`
            // reads the right number.
            const balance = await LeaveBalance.findOne({
                user_id: u._id,
                leave_type_id: slType._id,
                year,
            });
            if (balance) {
                balance.monthly_forfeited = (balance.monthly_forfeited || 0) + forfeitDays;
                balance.available = recomputeAvailable(balance);
                await balance.save();
            }

            summary.forfeited_users += 1;
        } catch (err) {
            summary.errors += 1;
            try {
                log.warn({ err, user_id: u._id.toString(), year, month }, 'SL forfeiture per-user step failed');
            } catch {
                // swallow
            }
        }
    }

    return summary;
};

/** Cron entry point — wraps the pure logic with the shared runner. */
export const runSlMonthlyForfeiture = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = slMonthlyForfeitureRunKey(now);
    return runJob(
        JOB_NAMES.SL_MONTHLY_FORFEITURE,
        runKey,
        async (ctx) => {
            // Day-of-month gate. We still hold the lock on the run-key so a
            // second non-last-day fire later in the day is also a no-op.
            if (!isLastDayOfMonth(now)) {
                ctx.log.info({ today: runKey }, 'SL forfeiture: today is not the last day of the month — skipping');
                return {
                    skipped_not_last_day: true,
                    target_year: dayjs(now).tz(DEFAULT_TIMEZONE).year(),
                    target_month: dayjs(now).tz(DEFAULT_TIMEZONE).month() + 1,
                };
            }
            const d = dayjs(now).tz(DEFAULT_TIMEZONE);
            return forfeitSlForMonth(d.year(), d.month() + 1, ctx.log);
        },
        opts
    );
};

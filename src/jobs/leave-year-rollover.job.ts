import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { JOB_NAMES, leaveYearRolloverRunKey } from '../constants/jobs.js';
import { initializeYearForAllUsers } from '../services/leave-balance.service.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * 14.3 Leave-year rollover (Plan §8 row 3).
 *
 * Jan 1 at 00:05 IST. For every active internal user, ensure a
 * `(user, leave_type, year=N+1)` balance row exists for every active leave
 * type. The actual rollover semantics fall out for free from the Phase-1
 * leave model:
 *
 *  - **CL / SL** — `carry_forward = false` on the type. New row gets a fresh
 *    `allocated` from `computeAllocation()` (which knows about pro-rata for
 *    mid-year joiners) and zeros for `used / pending / monthly_forfeited`.
 *  - **WFH / Maternity / Paternity / Unpaid** — unlimited or event-based,
 *    `allocated = 0` by `computeAllocation`. Untouched.
 *  - **Comp-off** — `is_earned = true`. `computeAllocation` returns 0 for
 *    the new row; the source of truth is `comp_off_ledger` which is
 *    timeless and not touched by the rollover. The cached
 *    `users.comp_off_balance` retains its current value.
 *  - **Year-spanning reservations** — when a Dec → Jan request is approved
 *    in December, `findOrInitBalance` already creates the year=N+1 row and
 *    bumps `pending`. The rollover uses `$setOnInsert` so that pre-existing
 *    row (with the carried `pending`) is preserved verbatim.
 *
 * Idempotency:
 *  - Run-key is the target year (`YYYY`). Re-running the job in the same
 *    year is a no-op via the `job_runs` unique index.
 *  - The underlying `initializeYearForAllUsers` is itself idempotent
 *    (`$setOnInsert` on the leave-balance composite key) so a partial
 *    previous run + a retry leave the DB in the right shape.
 */

interface RolloverSummary extends Record<string, unknown> {
    target_year: number;
    processed_users: number;
    total_inserted: number;
}

/** Pure logic — exported for unit tests. */
export const rolloverLeaveYear = async (targetYear: number, log: JobContext['log']): Promise<RolloverSummary> => {
    log.info({ year: targetYear }, 'Leave-year rollover starting');
    const result = await initializeYearForAllUsers({ year: targetYear });
    return {
        target_year: result.year,
        processed_users: result.processed_users,
        total_inserted: result.total_inserted,
    };
};

/** Cron entry point — wraps the pure logic with the shared runner. */
export const runLeaveYearRollover = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = leaveYearRolloverRunKey(now);
    const targetYear = dayjs(now).tz(DEFAULT_TIMEZONE).year();
    // BACKEND_AUDIT.md P1-6 — retry up to 3 times on transient errors.
    // The next scheduled run is a YEAR away; a transient Mongo blip
    // here would skip the rollover and leave every user without their
    // new-year leave balances. Caller-supplied `maxAttempts` overrides.
    return runJob(JOB_NAMES.LEAVE_YEAR_ROLLOVER, runKey, async (ctx) => rolloverLeaveYear(targetYear, ctx.log), {
        maxAttempts: 3,
        ...opts,
    });
};

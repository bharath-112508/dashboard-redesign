import { JOB_NAMES, compOffAccrualRunKey } from '../constants/jobs.js';
import { accrueCompOffForDay } from '../services/comp-off-accrual.service.js';
import { runJob, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * Automatic comp-off accrual — 23:15 IST daily, just after the attendance
 * finalizer. Processes the same finalized day ("yesterday" IST): converts
 * each user's overtime (running bank) + weekend/holiday work into comp-off
 * ledger grants.
 *
 * No-op unless `settings.leave_policy.comp_off_auto_accrual_enabled` is on.
 * Idempotent per attendance record (the `comp_off_accrued` flag), and the
 * `{job, run_key}` overlap guard keys off the target date so a manual re-run
 * on the same day is safe.
 *
 * See docs/superpowers/specs/2026-07-21-comp-off-auto-accrual-design.md.
 */
export const runCompOffAccrual = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = compOffAccrualRunKey(now); // = the target date (yesterday, IST)
    return runJob(
        JOB_NAMES.COMP_OFF_ACCRUAL,
        runKey,
        async (ctx) => {
            const result = await accrueCompOffForDay(runKey);
            ctx.log.info(result, 'comp-off accrual complete');
            return result;
        },
        opts
    );
};

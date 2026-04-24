import { RefreshToken } from '../models/refresh-token.model.js';
import { PasswordResetToken } from '../models/password-reset-token.model.js';
import { JOB_NAMES, tokenCleanupRunKey } from '../constants/jobs.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * 14.4 Refresh- / password-reset-token cleanup (Plan §8 row 6).
 *
 * Sunday 02:00 IST. Both collections already have `expireAfterSeconds: 0`
 * TTL indexes on `expires_at` so Mongo wakes up roughly every 60 seconds
 * and culls stale rows on its own. This job is the **belt-and-braces**
 * fallback (per BUILD_PROGRESS Step 14.4) for two real-world scenarios:
 *
 *  1. **TTL drift after a failover / restore.** Rows that survived a backup
 *     restore can sit past their `expires_at` until the next TTL sweep —
 *     this job sweeps them immediately on the weekly run.
 *  2. **Revoked-then-expired refresh-token rows** kept for forensics. We
 *     also clear refresh tokens that are revoked AND past their original
 *     expiry, since the audit value has dropped to ~zero.
 *  3. **Used-then-expired password-reset rows** for the same forensic
 *     reason.
 *
 * The job is intentionally narrow — it never touches a row whose
 * `expires_at` is still in the future, even if `revoked_at` / `used_at` is
 * set. That keeps the (currently disabled) Phase-3 admin "session listing"
 * UI honest.
 *
 * Idempotency:
 *  - Run-key is the IST ISO week. Two ticks in the same week (e.g. a
 *    manual re-run) collide on the `job_runs` unique index.
 *  - The underlying delete is naturally idempotent — a second run finds
 *    fewer / no rows to delete.
 */

interface TokenCleanupSummary extends Record<string, unknown> {
    refresh_tokens_deleted: number;
    password_reset_tokens_deleted: number;
}

/** Pure logic — exported for unit tests. */
export const cleanupTokens = async (now: Date, log: JobContext['log']): Promise<TokenCleanupSummary> => {
    const summary: TokenCleanupSummary = {
        refresh_tokens_deleted: 0,
        password_reset_tokens_deleted: 0,
    };

    // Refresh tokens — past expiry (any state).
    const refreshDeleted = await RefreshToken.deleteMany({
        expires_at: { $lt: now },
    });
    summary.refresh_tokens_deleted = refreshDeleted.deletedCount ?? 0;

    // Password reset tokens — past expiry (any state).
    const resetDeleted = await PasswordResetToken.deleteMany({
        expires_at: { $lt: now },
    });
    summary.password_reset_tokens_deleted = resetDeleted.deletedCount ?? 0;

    log.info(summary, 'Token cleanup finished');
    return summary;
};

/** Cron entry point — wraps the pure logic with the shared runner. */
export const runTokenCleanup = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = tokenCleanupRunKey(now);
    return runJob(JOB_NAMES.TOKEN_CLEANUP, runKey, async (ctx) => cleanupTokens(now, ctx.log), opts);
};

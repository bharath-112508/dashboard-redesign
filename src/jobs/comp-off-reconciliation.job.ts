import { Types } from 'mongoose';

import { CompOffLedger } from '../models/comp-off-ledger.model.js';
import { User } from '../models/user.model.js';
import { recomputeBalance } from '../services/comp-off.service.js';
import { JOB_NAMES, JOB_USER_BATCH_SIZE, compOffReconciliationRunKey } from '../constants/jobs.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * M42 — nightly comp-off balance reconciliation (02:30 IST daily).
 *
 * Background: pre-M42 the comp-off `adjustCompOff` hot path re-
 * aggregated the entire `comp_off_ledger` on every grant/consume (twice
 * — before AND after the CAS) so `User.comp_off_balance` stayed
 * authoritative against the ledger sum. That was O(ledger-size) per
 * adjust, which for tenured users with hundreds of rows was wasted
 * work on every operator click.
 *
 * Post-M42 the grant/consume path trusts the CAS `$inc` for balance
 * maintenance (C3 already does this atomically). This cron is the
 * safety net: once a day it walks users with ledger activity,
 * recomputes the sum, and repairs any drift it finds.
 *
 * Drift sources we defend against:
 *   1. A direct `db.compofflenders.insert(...)` outside the service
 *      (smoke seed, backfill script, manual ops repair) that didn't
 *      pair with a corresponding `User.$inc`.
 *   2. A future bug in the service that drops the `$inc` on one path.
 *   3. A restored backup where User and CompOffLedger were taken at
 *      different points in time.
 *
 * Repair policy: auto-fix. The cron emits a WARN log per affected
 * user (`COMP_OFF_DRIFT_REPAIRED`) so ops sees the signal; the user
 * row gets its balance reset to the ledger sum on the spot. The
 * conservative alternative ("alert but don't auto-fix") would strand
 * users with a bad balance until a human investigates — worse UX.
 *
 * Idempotency: run-key is `YYYY-MM-DD` (IST). Same-day re-runs (ops
 * manual trigger) collide on the `job_runs` unique index.
 */

interface CompOffReconciliationSummary extends Record<string, unknown> {
    users_scanned: number;
    users_in_sync: number;
    users_repaired: number;
    /** Diagnostic — total absolute drift across repaired rows. */
    total_drift_days: number;
}

/**
 * Pure logic — exported for unit tests. The cron entry point wraps
 * this with the shared `runJob` lifecycle (lock, run, audit, never
 * throw).
 */
export const reconcileCompOffBalances = async (log: JobContext['log']): Promise<CompOffReconciliationSummary> => {
    const summary: CompOffReconciliationSummary = {
        users_scanned: 0,
        users_in_sync: 0,
        users_repaired: 0,
        total_drift_days: 0,
    };

    // Enumerate every user with at least one ledger entry — users with
    // zero ledger activity have `comp_off_balance: 0` by construction and
    // don't need scanning.
    const cursor = CompOffLedger.aggregate<{ _id: Types.ObjectId }>([
        { $match: { user_id: { $exists: true } } },
        { $group: { _id: '$user_id' } },
    ]).cursor({ batchSize: JOB_USER_BATCH_SIZE });

    for await (const row of cursor) {
        summary.users_scanned += 1;

        // Lot-authoritative balance = Σ `remaining_days` over non-expired
        // earned lots. Pre-read the stored value BEFORE recomputing,
        // because `recomputeBalance` writes the authoritative sum back to
        // `User.comp_off_balance` as a side effect — that write IS the
        // drift repair. Comparing the pre-read value to the returned
        // balance is how we detect (and thus log) drift.
        const user = await User.findById(row._id).select('comp_off_balance').lean<{
            _id: Types.ObjectId;
            comp_off_balance: number | null | undefined;
        } | null>();
        if (!user) {
            // Ledger row references a deleted user. Rare (we don't
            // hard-delete users) — log and skip.
            try {
                log.warn(
                    { user_id: row._id.toString() },
                    'Comp-off ledger row references a user that no longer exists; skipping reconciliation'
                );
            } catch {
                // never throw from a log line
            }
            continue;
        }
        const storedBalance = user.comp_off_balance ?? 0;
        const { balance: ledgerBalance } = await recomputeBalance(row._id);
        if (storedBalance === ledgerBalance) {
            summary.users_in_sync += 1;
            continue;
        }

        // `recomputeBalance` has already applied the $set repair to the
        // ledger sum; we only surface the drift signal here.
        const drift = Math.abs(storedBalance - ledgerBalance);
        summary.users_repaired += 1;
        summary.total_drift_days += drift;
        try {
            log.warn(
                {
                    code: 'COMP_OFF_DRIFT_REPAIRED',
                    user_id: row._id.toString(),
                    stored_balance: storedBalance,
                    ledger_balance: ledgerBalance,
                    drift,
                },
                'Comp-off balance drift detected; repairing to ledger sum'
            );
        } catch {
            // never throw from a log line
        }
    }

    log.info(summary, 'Comp-off reconciliation finished');
    return summary;
};

/** Cron entry point — wraps the pure logic with the shared runner. */
export const runCompOffReconciliation = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = compOffReconciliationRunKey(now);
    return runJob(JOB_NAMES.COMP_OFF_RECONCILIATION, runKey, async (ctx) => reconcileCompOffBalances(ctx.log), opts);
};

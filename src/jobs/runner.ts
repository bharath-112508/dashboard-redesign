import os from 'node:os';

import { JobRun } from '../models/job-run.model.js';
import { recordSystemAudit } from '../services/audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { JOB_LOCK_STALE_MS, JOB_RUN_STATUSES, type JobName } from '../constants/jobs.js';
import logger from '../utils/logger.js';
import { jobRunDurationSeconds, jobRunsTotal } from '../utils/metrics.js';

/**
 * Job runner — Step 14 plumbing shared by every cron-triggered job.
 *
 * Responsibilities:
 *  1. **Idempotency lock.** Insert (or reclaim a stale row) into `job_runs`
 *     keyed by `(name, run_key)`. The unique compound index turns
 *     "duplicate fire" into a no-op: a competing scheduler / manual call
 *     for the same window collides on E11000 and the runner skips.
 *  2. **Stale-lock recovery.** A previously crashed run leaves a row stuck
 *     at `status: running`. Once `started_at` is older than
 *     `JOB_LOCK_STALE_MS` (30 min today) the runner reclaims it via
 *     `findOneAndUpdate`. `success` rows never re-run for the same key.
 *  3. **Run lifecycle.** On entry → row at `running`. On clean exit →
 *     `success` + `summary` + `duration_ms`. On exception → `failed` +
 *     `error_message` + `duration_ms`. Either way, the runner emits a
 *     `system.job_run` audit row with the same data so the (future Phase-3)
 *     audit screen has a single feed for ops.
 *  4. **Never throws.** Any error from the inner job, from the audit dispatch,
 *     or from the row update is caught and logged at warn / error. Cron
 *     ticks must never crash the host process — the next scheduled run is
 *     the recovery mechanism.
 *
 * The runner is process-local for Phase 1 (single `node-cron` instance per
 * `Build_Decisions §JobRuntime`). The DB lock is still real and would
 * survive a horizontal scale-out unchanged — only the cron firing itself
 * would need a shared scheduler at that point.
 */

export interface JobContext {
    name: JobName;
    /** Logical idempotency key for this run window (e.g. "2026-04-23"). */
    runKey: string;
    /** Wall-clock when the runner acquired the lock. */
    startedAt: Date;
    /** Per-run logger child for structured tagging. */
    log: typeof logger;
}

/**
 * Pure function shape every job exports. Receives the run context, returns
 * a free-form summary blob (counters, processed counts, etc.) that gets
 * stored on the `job_runs` row and folded into the audit metadata.
 */
export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown>>;

export interface RunJobOptions {
    /**
     * If `true`, throw on lock contention / job error (instead of swallowing).
     * Used by tests + future manual-trigger admin endpoint where the caller
     * wants to see the failure synchronously. Defaults to `false` so cron
     * ticks stay non-throwing.
     */
    throwOnError?: boolean;
    /**
     * In-tick retry budget (BACKEND_AUDIT.md P1-6). When > 1 the runner
     * retries a failed handler with exponential backoff (1s, 2s, 4s, …)
     * before recording the run as failed. Defaults to 1 (no retry — the
     * legacy behaviour). Use this on jobs where a transient Mongo / Blob
     * blip would skip a window with downstream consequences (e.g. SL
     * forfeiture, leave-year rollover) — there the next scheduled tick
     * is too late to recover.
     *
     * Lock semantics are preserved across retries: the same `job_runs`
     * row stays at `running`, only `error_message` is updated mid-flight
     * if the operator queries it. The job is only marked `failed` after
     * the final attempt fails.
     */
    maxAttempts?: number;
}

export interface RunJobResult {
    status: 'success' | 'failed' | 'skipped';
    runKey: string;
    durationMs: number;
    summary: Record<string, unknown>;
    error?: string;
}

const HOST = os.hostname();

// ─── Lock acquisition ────────────────────────────────────────────────────

const isE11000 = (err: unknown): boolean =>
    !!err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000;

/**
 * Try to claim the (name, run_key) row. Returns `true` if we now own the
 * lock and should run, `false` if it's already taken by a healthy run / a
 * completed success.
 */
const acquireLock = async (name: JobName, run_key: string, startedAt: Date): Promise<boolean> => {
    try {
        await JobRun.create({
            name,
            run_key,
            status: JOB_RUN_STATUSES.RUNNING,
            started_at: startedAt,
            host: HOST,
            pid: process.pid,
        });
        return true;
    } catch (err) {
        if (!isE11000(err)) throw err;
    }

    // Existing row — either still healthy ("running" within the stale
    // window), already finished, or a stale crash residue we can reclaim.
    const staleBefore = new Date(Date.now() - JOB_LOCK_STALE_MS);
    const reclaimed = await JobRun.findOneAndUpdate(
        {
            name,
            run_key,
            status: JOB_RUN_STATUSES.RUNNING,
            started_at: { $lt: staleBefore },
        },
        {
            $set: {
                status: JOB_RUN_STATUSES.RUNNING,
                started_at: startedAt,
                finished_at: null,
                duration_ms: null,
                error_message: null,
                host: HOST,
                pid: process.pid,
            },
        },
        { new: true }
    );

    return !!reclaimed;
};

// ─── Public entry point ──────────────────────────────────────────────────

/**
 * F5 — registry of in-flight `runJob` promises. `stopScheduler` awaits
 * `Promise.allSettled([...inFlight])` before resolving so a SIGTERM
 * during a long-running cron handler (audit-log mirror upload, monthly
 * forfeiture user-iteration) doesn't truncate mid-write.
 *
 * The set holds the OUTER promise returned by `runJob`, not the raw
 * handler — that way every concern the runner already wraps (DB
 * lifecycle update, audit emit, retry loop) gets to drain.
 */
const inFlightRunJobs: Set<Promise<RunJobResult>> = new Set();

/**
 * Snapshot of currently-running `runJob` promises. Exposed so
 * `stopScheduler` can await them; tests can inspect cardinality
 * without colliding on import order.
 */
export const getInFlightRunJobs = (): readonly Promise<RunJobResult>[] => [...inFlightRunJobs];

/**
 * Run a single job under the shared runner contract. See module header for
 * the lifecycle / audit / never-throw guarantees.
 */
export const runJob = (
    name: JobName,
    runKey: string,
    handler: JobHandler,
    opts: RunJobOptions = {}
): Promise<RunJobResult> => {
    const promise = runJobInner(name, runKey, handler, opts);
    inFlightRunJobs.add(promise);
    promise
        .finally(() => inFlightRunJobs.delete(promise))
        .catch(() => {
            // The inner already swallows + records the failure path; the
            // .catch() here is purely to keep an unhandled-rejection
            // warning off the bookkeeping promise.
        });
    return promise;
};

const runJobInner = async (
    name: JobName,
    runKey: string,
    handler: JobHandler,
    opts: RunJobOptions = {}
): Promise<RunJobResult> => {
    const startedAt = new Date();
    const childLog = logger.child({ job: name, run_key: runKey });

    // Step 1 — claim the lock.
    let acquired: boolean;
    try {
        acquired = await acquireLock(name, runKey, startedAt);
    } catch (err) {
        childLog.error({ err, code: ERROR_CODES.JOB_RUN_FAILED }, 'Job lock acquisition failed');
        if (opts.throwOnError) throw err;
        return {
            status: 'failed',
            runKey,
            durationMs: 0,
            summary: {},
            error: err instanceof Error ? err.message : String(err),
        };
    }

    if (!acquired) {
        childLog.info({ code: 'JOB_RUN_SKIPPED' }, 'Job run skipped — already done or lock held');
        jobRunsTotal.inc({ name, status: 'skipped' });
        return { status: 'skipped', runKey, durationMs: 0, summary: {} };
    }

    // Step 2 — execute (with optional in-tick retry on transient errors).
    childLog.info({ pid: process.pid, host: HOST }, 'Job run started');

    const maxAttempts = Math.max(1, opts.maxAttempts ?? 1);
    let summary: Record<string, unknown> = {};
    let runError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        runError = null;
        try {
            summary = await handler({ name, runKey, startedAt, log: childLog });
            break;
        } catch (err) {
            runError = err;
            if (attempt >= maxAttempts) break;
            // Exponential backoff: 1s, 2s, 4s, ... — capped to keep a
            // misbehaving handler from blocking the next cron window.
            const backoffMs = Math.min(2 ** (attempt - 1) * 1000, 30_000);
            try {
                childLog.warn(
                    { err, attempt, max_attempts: maxAttempts, backoff_ms: backoffMs },
                    'Job handler threw — retrying after backoff'
                );
            } catch {
                // swallow — never propagate from the retry log line.
            }
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
    }
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    // Step 3 — finalize the row + emit the audit. Both are wrapped in
    // try/catch so a flaky DB or audit logger can never crash the cron.
    const finalStatus = runError ? JOB_RUN_STATUSES.FAILED : JOB_RUN_STATUSES.SUCCESS;

    // Prometheus signals — emit BEFORE the DB write so a flaky audit
    // table can't suppress the metric.
    jobRunsTotal.inc({ name, status: finalStatus });
    jobRunDurationSeconds.observe({ name, status: finalStatus }, durationMs / 1000);
    try {
        await JobRun.updateOne(
            { name, run_key: runKey },
            {
                $set: {
                    status: finalStatus,
                    finished_at: finishedAt,
                    duration_ms: durationMs,
                    summary,
                    error_message:
                        runError instanceof Error ? runError.message : runError !== null ? String(runError) : null,
                },
            }
        );
    } catch (writeErr) {
        try {
            childLog.error({ err: writeErr }, 'Failed to update job_runs row');
        } catch {
            // swallow — never propagate.
        }
    }

    // Audit row (best effort — `recordSystemAudit` itself never throws).
    await recordSystemAudit({
        action: AUDIT_ACTIONS.SYSTEM_JOB_RUN,
        target: { kind: AUDIT_TARGET_KINDS.JOB, id: null },
        metadata: {
            job_name: name,
            run_key: runKey,
            status: finalStatus,
            duration_ms: durationMs,
            host: HOST,
            pid: process.pid,
            summary,
            error: runError instanceof Error ? runError.message : runError ? String(runError) : undefined,
        },
    });

    if (runError) {
        try {
            childLog.error(
                { err: runError, code: ERROR_CODES.JOB_RUN_FAILED, duration_ms: durationMs },
                'Job run failed'
            );
        } catch {
            // swallow
        }
        if (opts.throwOnError) throw runError;
        return {
            status: 'failed',
            runKey,
            durationMs,
            summary,
            error: runError instanceof Error ? runError.message : String(runError),
        };
    }

    childLog.info({ duration_ms: durationMs, summary }, 'Job run finished');
    return { status: 'success', runKey, durationMs, summary };
};

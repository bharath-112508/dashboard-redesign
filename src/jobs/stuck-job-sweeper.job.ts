import { Types } from 'mongoose';

import { JobRun } from '../models/job-run.model.js';
import { ReportExport } from '../models/report-export.model.js';
import { JOB_LOCK_STALE_MS, JOB_NAMES, JOB_RUN_STATUSES, stuckJobSweeperRunKey } from '../constants/jobs.js';
import { EXPORT_STATUSES } from '../constants/export.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { stuckJobSweepsTotal } from '../utils/metrics.js';

import { runJob, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * Stuck-job sweeper (BACKEND_AUDIT.md P1-6, T9).
 *
 * Sweeps two collections every 15 minutes:
 *
 *  1. `job_runs` (P1-6) — cron rows stuck at `running` past
 *     `JOB_LOCK_STALE_MS`. Existing reactive reclaim in
 *     `runner.ts:acquireLock` lets the next scheduled run rescue a
 *     stale row; this proactive companion makes them observable
 *     immediately.
 *
 *  2. `report_exports` (T9) — async export rows stuck at `running`
 *     past `EXPORT_STUCK_THRESHOLD_MS`. A SIGTERM during a PDF/XLSX
 *     render leaves the row in flight; without this sweep the user
 *     sees a hung export until `expires_at` (default 7 days). Set to
 *     `failed` with a synthetic error_message so the FE can surface
 *     "this export crashed, please retry" within ~15 minutes.
 *
 * Sweeping is purely a status-update — we never re-trigger the actual
 * handler / worker. The next scheduled run / next user click picks up
 * fresh.
 */

/**
 * Threshold for marking a `report_exports` row stuck. Same lineage
 * as `JOB_LOCK_STALE_MS` (30 min) — the export worker for our
 * largest reports is sub-minute even on a slow Mongo, so 30 min is
 * very generous and definitely a sign of a crashed render.
 */
export const EXPORT_STUCK_THRESHOLD_MS = JOB_LOCK_STALE_MS;

export const sweepStuckJobs = async (now: Date = new Date()): Promise<{ swept: number; jobs: string[] }> => {
    const staleBefore = new Date(now.getTime() - JOB_LOCK_STALE_MS);
    const stuck = await JobRun.find({
        status: JOB_RUN_STATUSES.RUNNING,
        started_at: { $lt: staleBefore },
    })
        .select('_id name run_key started_at host pid')
        .lean<
            {
                _id: Types.ObjectId;
                name: string;
                run_key: string;
                started_at: Date;
                host: string;
                pid: number;
            }[]
        >();

    if (stuck.length === 0) return { swept: 0, jobs: [] };

    const ids = stuck.map((r) => r._id);
    const stuckMs = (r: { started_at: Date }) => now.getTime() - r.started_at.getTime();

    await JobRun.updateMany(
        { _id: { $in: ids }, status: JOB_RUN_STATUSES.RUNNING },
        {
            $set: {
                status: JOB_RUN_STATUSES.FAILED,
                finished_at: now,
                error_message: 'Auto-failed by stuck_job_sweeper after exceeding JOB_LOCK_STALE_MS without completion',
            },
        }
    );
    stuckJobSweepsTotal.inc(stuck.length);

    return {
        swept: stuck.length,
        jobs: stuck.map((r) => `${r.name}/${r.run_key} (host=${r.host} pid=${r.pid} stuck=${stuckMs(r)}ms)`),
    };
};

/**
 * T9 — sweep `report_exports` rows stuck at `running` past the
 * threshold. Mirrors `sweepStuckJobs` shape for symmetry.
 */
export const sweepStuckExports = async (now: Date = new Date()): Promise<{ swept: number; ids: string[] }> => {
    const staleBefore = new Date(now.getTime() - EXPORT_STUCK_THRESHOLD_MS);
    const stuck = await ReportExport.find({
        status: EXPORT_STATUSES.RUNNING,
        started_at: { $lt: staleBefore },
    })
        .select('_id requested_by_user_id report_name format started_at')
        .lean<
            {
                _id: Types.ObjectId;
                requested_by_user_id: Types.ObjectId;
                report_name: string;
                format: string;
                started_at: Date;
            }[]
        >();

    if (stuck.length === 0) return { swept: 0, ids: [] };

    const ids = stuck.map((r) => r._id);
    await ReportExport.updateMany(
        { _id: { $in: ids }, status: EXPORT_STATUSES.RUNNING },
        {
            $set: {
                status: EXPORT_STATUSES.FAILED,
                completed_at: now,
                error_message:
                    'Auto-failed by stuck_job_sweeper after exceeding the export staleness threshold without completion',
                error_code: ERROR_CODES.JOB_RUN_FAILED,
            },
        }
    );

    return {
        swept: stuck.length,
        ids: stuck.map((r) => r._id.toString()),
    };
};

export const runStuckJobSweeperJob = async (
    now: Date = new Date(),
    opts: RunJobOptions = {}
): Promise<RunJobResult> => {
    return runJob(
        JOB_NAMES.STUCK_JOB_SWEEPER,
        stuckJobSweeperRunKey(now),
        async (ctx) => {
            const jobsResult = await sweepStuckJobs(now);
            if (jobsResult.swept > 0) {
                ctx.log.warn(
                    { swept: jobsResult.swept, jobs: jobsResult.jobs },
                    'Stuck-job sweep auto-failed running job_runs rows past JOB_LOCK_STALE_MS'
                );
            }

            const exportsResult = await sweepStuckExports(now);
            if (exportsResult.swept > 0) {
                ctx.log.warn(
                    { swept: exportsResult.swept, exports: exportsResult.ids },
                    'Stuck-job sweep auto-failed report_exports rows past EXPORT_STUCK_THRESHOLD_MS (T9)'
                );
            }

            return {
                swept_jobs: jobsResult.swept,
                swept_exports: exportsResult.swept,
                jobs: jobsResult.jobs,
                exports: exportsResult.ids,
            };
        },
        opts
    );
};

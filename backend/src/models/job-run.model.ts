import { Schema, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { JOB_NAME_VALUES, JOB_RUN_STATUS_VALUES, type JobName, type JobRunStatus } from '../constants/jobs.js';

/**
 * `job_runs` — Step 14 (Plan §8 reliability/idempotency).
 *
 * One row per `(name, run_key)`. The unique compound index turns the
 * scheduler into a serial point-in-time machine: a duplicate fire — whether
 * from a manual trigger overlapping the cron, an accidental second process,
 * or an at-least-once retry — collides on the index and the runner treats
 * the E11000 as "already done; skip".
 *
 * Status lifecycle:
 *
 *   running ──success──▶ success
 *      │
 *      ├──fail───────▶ failed
 *      └──skip───────▶ skipped
 *
 * `failed` rows are kept (audit trail for ops) but the runner allows a
 * later in-window retry by considering them "stale" once `started_at` is
 * older than `JOB_LOCK_STALE_MS`. `success` rows never re-run for the same
 * key — that's the whole point of the idempotency contract.
 *
 * `summary` is a free-form JSON blob the job populates with whatever
 * counters made sense (e.g. `{ users_processed: 42, rows_inserted: 12 }`).
 * It feeds the audit-log `metadata.summary` and the future ops dashboard.
 */

export interface JobRunDocument extends Document {
    _id: import('mongoose').Types.ObjectId;
    name: JobName | string;
    run_key: string;
    /**
     * M27 — unique per `runJob` invocation (UUID v4). `run_key` is the
     * wall-clock window key (e.g. `2026-06-08`), which is shared by
     * every retry of the same window — collisions make log lines from
     * two retries indistinguishable in App Insights. `run_id` is
     * minted fresh on each lock-acquire / stale-reclaim, pinned onto
     * the pino child logger, and persisted here for correlation.
     * Nullable on pre-M27 rows.
     */
    run_id: string | null;
    status: JobRunStatus;
    started_at: Date;
    finished_at: Date | null;
    duration_ms: number | null;
    summary: Record<string, unknown>;
    error_message: string | null;
    host: string;
    pid: number;
    created_at: Date;
    updated_at: Date;
}

const jobRunSchema = new Schema<JobRunDocument>(
    {
        name: { type: String, required: true, enum: [...JOB_NAME_VALUES] },
        run_key: { type: String, required: true },
        run_id: { type: String, default: null },
        status: {
            type: String,
            required: true,
            enum: [...JOB_RUN_STATUS_VALUES],
            default: 'running',
        },
        started_at: { type: Date, required: true, default: () => new Date() },
        finished_at: { type: Date, default: null },
        duration_ms: { type: Number, default: null },
        summary: { type: Schema.Types.Mixed, default: () => ({}) },
        error_message: { type: String, default: null },
        host: { type: String, default: '' },
        pid: { type: Number, default: 0 },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.JOB_RUNS,
    }
);

jobRunSchema.index({ name: 1, run_key: 1 }, { unique: true });
jobRunSchema.index({ name: 1, started_at: -1 });

export const JobRun: Model<JobRunDocument> = model<JobRunDocument>('JobRun', jobRunSchema);

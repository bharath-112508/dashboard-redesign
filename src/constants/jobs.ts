/**
 * Scheduled-job constants — Step 14 (Plan §8, BUILD_PROGRESS Step 14).
 *
 * Phase 1 ships these jobs, all driven by an in-process `node-cron`
 * scheduler running in the IST timezone:
 *
 *   14.1 Attendance finalizer       — daily 23:00 IST (closes yesterday)
 *   14.3 Leave-year rollover        — Jan 1 00:05 IST
 *   14.4 Refresh / reset-token gc   — weekly Sunday 02:00 IST
 *
 * M15 — 14.2 "Monthly SL forfeiture" was removed; it was structurally
 * dead under the current LEAVE_TYPE_SEEDS (SL ships `monthly_forfeiture:
 * false`). See the inline note on `JOB_NAMES` below.
 *
 * Each job has:
 *  - A canonical `name` used both as the audit-log subject and the
 *    `job_runs` row key.
 *  - A `cron` schedule and an explicit `timezone`. Cron expressions are
 *    standard 5-field (m h dom mon dow). All schedules are anchored to IST
 *    so the working-day boundary lines up with everything else (attendance
 *    `local_date`, leave segment math, dashboard "today").
 *  - An `idempotencyKey(now)` function that returns the natural unique key
 *    for a single run (e.g. "2026-04-23" for the daily finalizer or
 *    "2026-04" for the monthly forfeiture). The runner uses this to refuse
 *    duplicate executions for the same logical run window.
 *
 * Runtime choice: single-process `node-cron` for Phase 1 per
 * `Build_Decisions.md` (`Deferred §JobRuntime`); migration to Azure
 * Functions / hosted runner is a Phase 2 Step-23 decision gate. The
 * `JOBS_ENABLED` env flag lets the integration tests / smoke runs boot
 * the API without firing real schedules.
 */

import dayjs from '../utils/date.js';

export const JOB_TIMEZONE = 'Asia/Kolkata';

/**
 * If a job started this long ago and is still flagged "running", treat the
 * lock as stale and re-acquire. Belts-and-braces against a process crash
 * mid-run leaving an orphaned lock row. Each job's effective deadline is
 * `Math.max(JOB_LOCK_STALE_MS, custom override)`.
 */
export const JOB_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Maximum number of users a single job iterates over per "page". Keeps the
 * memory footprint flat for the EOD finalizer once headcount climbs.
 */
export const JOB_USER_BATCH_SIZE = 200;

/**
 * Graceful-shutdown drain window (L3). On SIGTERM the scheduler waits up
 * to this long for in-flight job callbacks to finish before forcibly
 * resolving and letting the process exit. Pinned at 25s so it falls
 * comfortably inside the typical container 30s SIGTERM→SIGKILL grace
 * window — leaving 5s for the rest of the shutdown sequence (Mongo
 * connection close, HTTP server graceful close, etc.). Bump only if a
 * specific job legitimately needs longer; otherwise an in-flight job
 * past 25s is almost always a stuck job and the stuck-job sweeper will
 * mark it failed on the next process boot.
 */
export const JOB_SCHEDULER_DRAIN_TIMEOUT_MS = 25_000;

/**
 * Consecutive-failure threshold for the cron observability hook (L4).
 * After a job fails this many times in a row, the runner emits a
 * `CRITICAL` log entry distinct from the per-failure `WARN`, so the
 * operator gets a single high-signal pager line for "this job has been
 * down for ~N hours" instead of sifting through N×repeat warns. The
 * counter resets on the first success.
 */
export const JOB_CONSECUTIVE_FAILURE_THRESHOLD = 3;

// ─── Job names (audit + log + db key) ─────────────────────────────────────

export const JOB_NAMES = {
    ATTENDANCE_FINALIZER: 'attendance_finalizer',
    // M15 — `SL_MONTHLY_FORFEITURE` removed. The job was structurally
    // dead under current policy (LEAVE_TYPE_SEEDS ships SL with
    // `monthly_forfeiture: false`, so the job's
    // `findOne({monthly_forfeiture: true})` always returned null and
    // logged "skipping" once a month). The `SlMonthlyForfeiture` model
    // + `COLLECTIONS.SL_MONTHLY_FORFEITURES` are deliberately retained
    // because `leave-balance.service.ts` and `leave-request.service.ts`
    // still read from the table — those reads gracefully handle the
    // empty-table case. If SL forfeiture is ever re-enabled, the model
    // and read paths are ready; the write side has to be a deliberate
    // re-introduction (not a flag flip) so destructive monthly resets
    // can't be accidentally activated.
    LEAVE_YEAR_ROLLOVER: 'leave_year_rollover',
    TOKEN_CLEANUP: 'token_cleanup',
    TIMESHEET_REMINDER: 'timesheet_reminder',
    REPORT_EXPORT_CLEANUP: 'report_export_cleanup',
    AUDIT_ARCHIVE: 'audit_archive',
    RECURRING_TASK_SWEEP: 'recurring_task_sweep',
    REPORT_SUBSCRIPTION_SWEEP: 'report_subscription_sweep',
    STUCK_JOB_SWEEPER: 'stuck_job_sweeper',
    AUDIT_LOG_MIRROR: 'audit_log_mirror',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const JOB_NAME_VALUES: readonly JobName[] = Object.values(JOB_NAMES);

// ─── Cron expressions (5-field; anchored to IST) ─────────────────────────

export const JOB_SCHEDULES: Record<JobName, string> = {
    // Daily 23:00 IST — closes yesterday's open records (we compute "yesterday"
    // inside the job at call time so a manual trigger is also correct).
    [JOB_NAMES.ATTENDANCE_FINALIZER]: '0 23 * * *',

    // 00:05 IST on Jan 1.
    [JOB_NAMES.LEAVE_YEAR_ROLLOVER]: '5 0 1 1 *',

    // Sunday 02:00 IST.
    [JOB_NAMES.TOKEN_CLEANUP]: '0 2 * * 0',

    // Daily 20:00 IST — gives users a window between EOD and bedtime to
    // log time before the reminder fires. Idempotent on the same day so
    // a manual re-run by ops is safe.
    [JOB_NAMES.TIMESHEET_REMINDER]: '0 20 * * *',

    // Daily 03:00 IST — purges report-export rows past `expires_at`
    // (default 7 days) and best-effort deletes their blobs. Off-peak so
    // a longer-than-expected delete loop on a busy storage account
    // doesn't compete with morning HTTP traffic.
    [JOB_NAMES.REPORT_EXPORT_CLEANUP]: '0 3 * * *',

    // Daily 04:00 IST — archives audit_logs rows past
    // `AUDIT_ARCHIVE_AFTER_DAYS` to immutable Blob storage. Off-peak.
    // Runs after the export cleanup so the two cron sweeps don't
    // contend on the same storage account in the same minute.
    [JOB_NAMES.AUDIT_ARCHIVE]: '0 4 * * *',

    // Daily 06:00 IST — instantiates recurring task templates whose
    // schedule fires today. Runs before normal work hours so users
    // see today's recurring tasks already on their kanban when they
    // log in.
    [JOB_NAMES.RECURRING_TASK_SWEEP]: '0 6 * * *',

    // Daily 07:00 IST — sends scheduled report-subscription emails
    // for subscriptions whose `day_of_week` matches today. Runs at
    // start-of-business so weekly digests land in inboxes around
    // when users start work.
    [JOB_NAMES.REPORT_SUBSCRIPTION_SWEEP]: '0 7 * * *',

    // Hourly at :07 — audit-log offsite mirror (BACKEND_AUDIT.md P1-7).
    // Streams new audit_logs rows since the last watermark to a
    // WORM Blob container. Defence-in-depth: even a compromised Mongo
    // can't rewrite history that's already been mirrored.
    [JOB_NAMES.AUDIT_LOG_MIRROR]: '7 * * * *',

    // Every 15 minutes — stuck-job sweeper (BACKEND_AUDIT.md P1-6).
    // Walks `job_runs` for rows still flagged `running` but past the
    // `JOB_LOCK_STALE_MS` deadline (i.e. orphaned by a process
    // crash) and marks them `failed` with a synthetic
    // `error_message`. Also reports the count via metrics so the
    // operator gets a signal beyond an audit-log dive. The
    // existing reactive reclaim in `acquireLock` covers the next-
    // run path; this proactive sweep makes stuck jobs observable
    // in real time.
    [JOB_NAMES.STUCK_JOB_SWEEPER]: '*/15 * * * *',
};

// ─── Per-run idempotency key derivation ──────────────────────────────────

/**
 * The attendance finalizer keys off **yesterday** (IST), since the 23:00
 * scheduled run is about closing the working day that just ended.
 */
export const attendanceFinalizerRunKey = (now: Date = new Date()): string => {
    return dayjs(now).tz(JOB_TIMEZONE).subtract(1, 'day').format('YYYY-MM-DD');
};

/** Leave-year rollover keys off the target year (the year just begun, IST). */
export const leaveYearRolloverRunKey = (now: Date = new Date()): string => {
    return dayjs(now).tz(JOB_TIMEZONE).format('YYYY');
};

/** Token cleanup keys off the ISO week so a re-run within the same week is a no-op. */
export const tokenCleanupRunKey = (now: Date = new Date()): string => {
    const d = dayjs(now).tz(JOB_TIMEZONE);
    return `${d.isoWeekYear()}-W${String(d.isoWeek()).padStart(2, '0')}`;
};

/**
 * Timesheet reminder keys off **today** (IST). The 20:00 fire is about
 * the day that's about to end, so a manual re-run before midnight is
 * idempotent (same key) and after midnight produces a fresh row for the
 * new day.
 */
export const timesheetReminderRunKey = (now: Date = new Date()): string => {
    return dayjs(now).tz(JOB_TIMEZONE).format('YYYY-MM-DD');
};

/**
 * Report-export cleanup keys off **today** (IST). One sweep per calendar
 * day; an ops re-run within the same day is idempotent (the second pass
 * finds the rows already deleted by the first).
 */
export const reportExportCleanupRunKey = (now: Date = new Date()): string => {
    return dayjs(now).tz(JOB_TIMEZONE).format('YYYY-MM-DD');
};

/**
 * Audit archive sweep keys off **today** (IST). The sweep itself is
 * idempotent (date-of-content is the dedup key on `audit_archives`)
 * so an ops re-run within the same day is a no-op for already-
 * archived dates.
 */
export const auditArchiveRunKey = (now: Date = new Date()): string => {
    return dayjs(now).tz(JOB_TIMEZONE).format('YYYY-MM-DD');
};

/**
 * Recurring task sweep keys off **today** (IST). Same-day re-runs
 * are no-ops via the per-template `recurrence.last_generated_at`
 * idempotency stamp, plus the outer `job_runs` unique index.
 */
export const recurringTaskSweepRunKey = (now: Date = new Date()): string => {
    return dayjs(now).tz(JOB_TIMEZONE).format('YYYY-MM-DD');
};

/**
 * Report-subscription sweep keys off **today** (IST). Same-day re-
 * runs are no-ops via the per-subscription `last_sent_at` stamp.
 */
export const reportSubscriptionSweepRunKey = (now: Date = new Date()): string => {
    return dayjs(now).tz(JOB_TIMEZONE).format('YYYY-MM-DD');
};

/**
 * Stuck-job sweeper keys off the 15-min wall-clock bucket so each cron
 * tick lands on a fresh row (no idempotency dedupe across ticks — every
 * 15 minutes is a separate audit point). Format: `YYYY-MM-DDTHH:mm`.
 */
export const stuckJobSweeperRunKey = (now: Date = new Date()): string => {
    const d = dayjs(now).tz(JOB_TIMEZONE);
    const minute = Math.floor(d.minute() / 15) * 15;
    return `${d.format('YYYY-MM-DDTHH')}:${String(minute).padStart(2, '0')}`;
};

/**
 * Audit-log mirror keys off the wall-clock hour (IST). One run per
 * hour; an ops re-run within the same hour is a no-op via the
 * `job_runs` unique index. Format: `YYYY-MM-DDTHH`.
 */
export const auditLogMirrorRunKey = (now: Date = new Date()): string => {
    return dayjs(now).tz(JOB_TIMEZONE).format('YYYY-MM-DDTHH');
};

// ─── Job-run row lifecycle ───────────────────────────────────────────────

export const JOB_RUN_STATUSES = {
    RUNNING: 'running',
    SUCCESS: 'success',
    FAILED: 'failed',
    SKIPPED: 'skipped',
} as const;

export type JobRunStatus = (typeof JOB_RUN_STATUSES)[keyof typeof JOB_RUN_STATUSES];

export const JOB_RUN_STATUS_VALUES: readonly JobRunStatus[] = Object.values(JOB_RUN_STATUSES);

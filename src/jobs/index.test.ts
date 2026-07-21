import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * L4 — consecutive-failure tracker test.
 *
 * Pre-L4 the cron tick caught + logged thrown errors and moved on,
 * with no signal for "this job has been failing for hours". L4 added
 * an in-process `Map<JobName, number>` counter:
 *   - successful tick → counter for that job is reset (delete)
 *   - failed tick    → counter increments
 *   - on the tick that crosses `JOB_CONSECUTIVE_FAILURE_THRESHOLD`,
 *     emit ONE `logger.fatal` line distinct from the per-tick error
 *
 * Pinning the contract here so a future refactor of the tick callback
 * doesn't silently drop the threshold-crossing signal.
 *
 * Setup pattern: mock `node-cron` so `schedule()` captures the tick
 * callback by job name. Mock each runner so we can flip them between
 * resolve and reject per test. Mock the logger to verify `.error` and
 * `.fatal` calls. `vi.resetModules()` between tests so the
 * `consecutiveFailures` Map starts fresh per test.
 */

const {
    cronScheduleMock,
    loggerErrorMock,
    loggerFatalMock,
    loggerInfoMock,
    loggerWarnMock,
    runAttendanceMock,
    runLeaveYearMock,
    runTokenCleanupMock,
    runTimesheetReminderMock,
    runReportExportMock,
    runAuditArchiveMock,
    runRecurringTaskMock,
    runReportSubMock,
    runStuckJobMock,
    runAuditLogMirrorMock,
    runCompOffReconciliationMock,
    runCompOffAccrualMock,
    runCheckinNudgeMock,
    runCheckoutReminderMock,
    getOrInitSettingsMock,
} = vi.hoisted(() => ({
    cronScheduleMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerFatalMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    runAttendanceMock: vi.fn(),
    runLeaveYearMock: vi.fn(),
    runTokenCleanupMock: vi.fn(),
    runTimesheetReminderMock: vi.fn(),
    runReportExportMock: vi.fn(),
    runAuditArchiveMock: vi.fn(),
    runRecurringTaskMock: vi.fn(),
    runReportSubMock: vi.fn(),
    runStuckJobMock: vi.fn(),
    runAuditLogMirrorMock: vi.fn(),
    runCompOffReconciliationMock: vi.fn(),
    runCompOffAccrualMock: vi.fn(),
    runCheckinNudgeMock: vi.fn(),
    runCheckoutReminderMock: vi.fn(),
    getOrInitSettingsMock: vi.fn(),
}));

vi.mock('node-cron', () => ({
    default: { schedule: cronScheduleMock },
}));

vi.mock('../utils/logger.js', () => ({
    default: {
        error: loggerErrorMock,
        fatal: loggerFatalMock,
        info: loggerInfoMock,
        warn: loggerWarnMock,
    },
}));

vi.mock('../config/server.config.js', () => ({
    JOBS_ENABLED: true,
}));

vi.mock('./runner.js', () => ({
    getInFlightRunJobs: () => [],
}));

vi.mock('./attendance-finalizer.job.js', () => ({
    runAttendanceFinalizer: runAttendanceMock,
}));
// M15 — `./sl-monthly-forfeiture.job.js` mock removed (file deleted).
// The "consecutive-failure isolation" test below was repurposed onto
// `LEAVE_YEAR_ROLLOVER` since it just needs a second healthy job to
// run alongside the failing attendance job; the SL job was only ever
// a fixture, not the subject under test.
vi.mock('./leave-year-rollover.job.js', () => ({
    runLeaveYearRollover: runLeaveYearMock,
}));
vi.mock('./token-cleanup.job.js', () => ({
    runTokenCleanup: runTokenCleanupMock,
}));
vi.mock('./timesheet-reminder.job.js', () => ({
    runTimesheetReminder: runTimesheetReminderMock,
}));
vi.mock('./report-export-cleanup.job.js', () => ({
    runReportExportCleanup: runReportExportMock,
}));
vi.mock('./audit-archive.job.js', () => ({
    runAuditArchive: runAuditArchiveMock,
}));
vi.mock('./recurring-task.job.js', () => ({
    runRecurringTaskSweepJob: runRecurringTaskMock,
}));
vi.mock('./report-subscription.job.js', () => ({
    runReportSubscriptionSweepJob: runReportSubMock,
}));
vi.mock('./stuck-job-sweeper.job.js', () => ({
    runStuckJobSweeperJob: runStuckJobMock,
}));
vi.mock('./audit-log-mirror.job.js', () => ({
    runAuditLogMirror: runAuditLogMirrorMock,
}));
// M42 — the comp-off reconciliation cron registers via `jobs/index.ts`.
// Without a mock, the test cache reset (`vi.resetModules()`) re-imports
// the real file → re-registers the `comp_off_ledger` Mongoose model →
// throws `OverwriteModelError`.
vi.mock('./comp-off-reconciliation.job.js', () => ({
    runCompOffReconciliation: runCompOffReconciliationMock,
}));
vi.mock('./comp-off-accrual.job.js', () => ({
    runCompOffAccrual: runCompOffAccrualMock,
}));
vi.mock('./attendance-slack-nudge.job.js', () => ({
    runAttendanceCheckinNudge: runCheckinNudgeMock,
    runAttendanceCheckoutReminder: runCheckoutReminderMock,
}));
// `startScheduler` reads nudge fire-times from settings at boot; stub the
// service so the test doesn't touch a real settings collection / Mongoose
// model. Default resolves to undefined → scheduler falls back to defaults.
vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: getOrInitSettingsMock,
}));

import { JOB_NAMES, JOB_CONSECUTIVE_FAILURE_THRESHOLD } from '../constants/jobs.js';

/** Pull the captured tick callback for a given job name out of the
 *  cron.schedule mock. The runtime invokes the callback every cron
 *  tick; our test invokes it manually to drive the tracker. */
const tickCallbackFor = (jobName: string): (() => void) => {
    for (const call of cronScheduleMock.mock.calls) {
        // call shape: [expression, callback, opts]. We can't match by
        // expression directly (the test doesn't know the cron strings),
        // so match by the order in which startScheduler iterates the
        // REGISTRY object. JOB_NAMES preserves declaration order
        // alongside REGISTRY in production code.
        const idx = cronScheduleMock.mock.calls.indexOf(call);
        const orderedNames = Object.values(JOB_NAMES);
        if (orderedNames[idx] === jobName) {
            return call[1] as () => void;
        }
    }
    throw new Error(`No tick callback captured for ${jobName}`);
};

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
    vi.resetAllMocks();
    cronScheduleMock.mockImplementation(() => ({ stop: vi.fn() }));
    // Default: every runner resolves successfully. Tests override.
    runAttendanceMock.mockResolvedValue(undefined);
    runLeaveYearMock.mockResolvedValue(undefined);
    runTokenCleanupMock.mockResolvedValue(undefined);
    runTimesheetReminderMock.mockResolvedValue(undefined);
    runReportExportMock.mockResolvedValue(undefined);
    runAuditArchiveMock.mockResolvedValue(undefined);
    runRecurringTaskMock.mockResolvedValue(undefined);
    runReportSubMock.mockResolvedValue(undefined);
    runStuckJobMock.mockResolvedValue(undefined);
    runAuditLogMirrorMock.mockResolvedValue(undefined);
    runCompOffReconciliationMock.mockResolvedValue(undefined);
    runCompOffAccrualMock.mockResolvedValue(undefined);
    runCheckinNudgeMock.mockResolvedValue(undefined);
    runCheckoutReminderMock.mockResolvedValue(undefined);
    // No nudge override → scheduler uses the static JOB_SCHEDULES defaults.
    getOrInitSettingsMock.mockResolvedValue({});
});

describe('startScheduler — L4 consecutive-failure tracker', () => {
    it('emits logger.fatal exactly once on the threshold-crossing tick', async () => {
        // Reset the module so the in-process `consecutiveFailures` Map
        // starts empty for this test.
        vi.resetModules();
        const { startScheduler } = await import('./index.js');

        runAttendanceMock.mockRejectedValue(new Error('attendance broke'));
        await startScheduler();
        const tick = tickCallbackFor(JOB_NAMES.ATTENDANCE_FINALIZER);

        // Three consecutive failures should cross the threshold (3) on
        // the third tick. Drive each through and let microtasks flush.
        for (let i = 0; i < JOB_CONSECUTIVE_FAILURE_THRESHOLD; i += 1) {
            tick();
            await flush();
        }

        // Each failed tick logs a per-tick error.
        expect(loggerErrorMock).toHaveBeenCalledTimes(JOB_CONSECUTIVE_FAILURE_THRESHOLD);
        // Exactly one fatal — the threshold-crossing tick.
        expect(loggerFatalMock).toHaveBeenCalledTimes(1);
        expect(loggerFatalMock).toHaveBeenCalledWith(
            expect.objectContaining({
                job: JOB_NAMES.ATTENDANCE_FINALIZER,
                consecutive_failures: JOB_CONSECUTIVE_FAILURE_THRESHOLD,
                threshold: JOB_CONSECUTIVE_FAILURE_THRESHOLD,
            }),
            expect.stringMatching(/threshold/i)
        );
    });

    it('does NOT emit logger.fatal a second time when failures continue past the threshold', async () => {
        vi.resetModules();
        const { startScheduler } = await import('./index.js');

        runAttendanceMock.mockRejectedValue(new Error('still broken'));
        await startScheduler();
        const tick = tickCallbackFor(JOB_NAMES.ATTENDANCE_FINALIZER);

        // Drive 5 consecutive failures (threshold + 2 extra).
        for (let i = 0; i < JOB_CONSECUTIVE_FAILURE_THRESHOLD + 2; i += 1) {
            tick();
            await flush();
        }

        // Per-tick errors fire on every tick.
        expect(loggerErrorMock).toHaveBeenCalledTimes(JOB_CONSECUTIVE_FAILURE_THRESHOLD + 2);
        // Fatal fires ONCE — on the threshold-crossing tick. Subsequent
        // failures don't re-fire fatal (deliberate, prevents log
        // spam — see jobs/index.ts L4 design comment).
        expect(loggerFatalMock).toHaveBeenCalledTimes(1);
    });

    it('resets the streak on a successful tick (next failure starts at 1)', async () => {
        vi.resetModules();
        const { startScheduler } = await import('./index.js');

        await startScheduler();
        const tick = tickCallbackFor(JOB_NAMES.ATTENDANCE_FINALIZER);

        // Two failures, then a success, then one failure. Total
        // failures = 3 but they're not CONSECUTIVE, so no fatal.
        runAttendanceMock.mockRejectedValueOnce(new Error('1'));
        tick();
        await flush();
        runAttendanceMock.mockRejectedValueOnce(new Error('2'));
        tick();
        await flush();
        runAttendanceMock.mockResolvedValueOnce(undefined);
        tick();
        await flush();
        runAttendanceMock.mockRejectedValueOnce(new Error('4'));
        tick();
        await flush();

        // 3 errors logged (one per failed tick).
        expect(loggerErrorMock).toHaveBeenCalledTimes(3);
        // Threshold never crossed — successful tick reset the streak
        // before the third consecutive failure could fire.
        expect(loggerFatalMock).not.toHaveBeenCalled();
    });

    it('tracks each job independently — failures on one job do not trip another', async () => {
        vi.resetModules();
        const { startScheduler } = await import('./index.js');

        runAttendanceMock.mockRejectedValue(new Error('attendance broken'));
        // Leave-year rollover stays healthy. (M15: was SL forfeiture
        // pre-deletion; swapped to another known-healthy job since the
        // test only needs two distinct jobs running side-by-side.)
        runLeaveYearMock.mockResolvedValue(undefined);

        await startScheduler();
        const attendanceTick = tickCallbackFor(JOB_NAMES.ATTENDANCE_FINALIZER);
        const healthyTick = tickCallbackFor(JOB_NAMES.LEAVE_YEAR_ROLLOVER);

        for (let i = 0; i < JOB_CONSECUTIVE_FAILURE_THRESHOLD; i += 1) {
            healthyTick(); // healthy ticks — should never trip
            attendanceTick(); // failing ticks
            await flush();
        }

        // Only the attendance job tripped fatal. Threshold is per-job.
        expect(loggerFatalMock).toHaveBeenCalledTimes(1);
        expect(loggerFatalMock).toHaveBeenCalledWith(
            expect.objectContaining({ job: JOB_NAMES.ATTENDANCE_FINALIZER }),
            expect.anything()
        );
    });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the shared job runner (Step 14).
 *
 * The runner is the only piece every cron job touches, so the contract
 * worth pinning at the unit level is:
 *
 *  1. Lock acquisition — a fresh (name, run_key) lets the handler run.
 *  2. Idempotency — an E11000 on insert (already done) skips cleanly.
 *  3. Stale-lock recovery — an existing "running" row older than the
 *     stale window is reclaimed by `findOneAndUpdate`.
 *  4. Success path — `JobRun.updateOne` is called with status=success
 *     and the summary, plus a `system.job_run` audit row is emitted.
 *  5. Failure path — handler throws → status=failed + error_message,
 *     audit still emitted, and (by default) the runner returns rather
 *     than re-throws.
 *  6. `throwOnError: true` — propagates the inner error for tests / the
 *     future manual-trigger admin endpoint.
 */

const { createMock, updateOneMock, findOneAndUpdateMock, recordSystemAuditMock } = vi.hoisted(() => ({
    createMock: vi.fn(),
    updateOneMock: vi.fn(),
    findOneAndUpdateMock: vi.fn(),
    recordSystemAuditMock: vi.fn(),
}));

vi.mock('../models/job-run.model.js', () => ({
    JobRun: {
        create: createMock,
        updateOne: updateOneMock,
        findOneAndUpdate: findOneAndUpdateMock,
    },
}));

vi.mock('../services/audit.service.js', () => ({
    recordSystemAudit: recordSystemAuditMock,
}));

vi.mock('../utils/logger.js', () => {
    const child = vi.fn();
    const base = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child,
    };
    child.mockReturnValue(base);
    return { default: base };
});

const { runJob } = await import('./runner.js');
import { JOB_NAMES, JOB_RUN_STATUSES } from '../constants/jobs.js';
import { AUDIT_ACTIONS } from '../constants/audit.js';

beforeEach(() => {
    createMock.mockReset();
    updateOneMock.mockReset();
    findOneAndUpdateMock.mockReset();
    recordSystemAuditMock.mockReset();

    updateOneMock.mockResolvedValue({});
    recordSystemAuditMock.mockResolvedValue(undefined);
});

describe('runJob', () => {
    it('happy path: acquires lock, runs handler, marks success and audits', async () => {
        createMock.mockResolvedValueOnce({});
        const handler = vi.fn().mockResolvedValue({ users_processed: 5 });

        const result = await runJob(JOB_NAMES.TOKEN_CLEANUP, '2026-W17', handler);

        expect(result.status).toBe('success');
        expect(result.summary).toEqual({ users_processed: 5 });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(updateOneMock).toHaveBeenCalledWith(
            { name: JOB_NAMES.TOKEN_CLEANUP, run_key: '2026-W17' },
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: JOB_RUN_STATUSES.SUCCESS,
                    summary: { users_processed: 5 },
                }),
            })
        );
        expect(recordSystemAuditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: AUDIT_ACTIONS.SYSTEM_JOB_RUN,
                metadata: expect.objectContaining({
                    job_name: JOB_NAMES.TOKEN_CLEANUP,
                    run_key: '2026-W17',
                    status: JOB_RUN_STATUSES.SUCCESS,
                    summary: { users_processed: 5 },
                }),
            })
        );
    });

    it('skips when (name, run_key) collides on E11000 and lock cannot be reclaimed', async () => {
        const dupErr = Object.assign(new Error('dup key'), { code: 11000 });
        createMock.mockRejectedValueOnce(dupErr);
        // No stale row to reclaim.
        findOneAndUpdateMock.mockResolvedValueOnce(null);

        const handler = vi.fn();
        const result = await runJob(JOB_NAMES.ATTENDANCE_FINALIZER, '2026-04-23', handler);

        expect(result.status).toBe('skipped');
        expect(handler).not.toHaveBeenCalled();
        expect(updateOneMock).not.toHaveBeenCalled();
        expect(recordSystemAuditMock).not.toHaveBeenCalled();
    });

    it('reclaims a stale running row and runs the handler', async () => {
        const dupErr = Object.assign(new Error('dup'), { code: 11000 });
        createMock.mockRejectedValueOnce(dupErr);
        findOneAndUpdateMock.mockResolvedValueOnce({ _id: 'reclaimed' });

        const handler = vi.fn().mockResolvedValue({ ok: true });
        const result = await runJob(JOB_NAMES.ATTENDANCE_FINALIZER, '2026-04-23', handler);

        expect(result.status).toBe('success');
        expect(handler).toHaveBeenCalledOnce();
        expect(findOneAndUpdateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                name: JOB_NAMES.ATTENDANCE_FINALIZER,
                run_key: '2026-04-23',
                status: JOB_RUN_STATUSES.RUNNING,
                started_at: expect.objectContaining({ $lt: expect.any(Date) }),
            }),
            expect.any(Object),
            expect.any(Object)
        );
    });

    it('failure path: marks the row failed, captures error_message, never throws by default', async () => {
        createMock.mockResolvedValueOnce({});
        const handler = vi.fn().mockRejectedValue(new Error('SL math broke'));

        const result = await runJob(JOB_NAMES.SL_MONTHLY_FORFEITURE, '2026-04', handler);

        expect(result.status).toBe('failed');
        expect(result.error).toBe('SL math broke');
        expect(updateOneMock).toHaveBeenCalledWith(
            { name: JOB_NAMES.SL_MONTHLY_FORFEITURE, run_key: '2026-04' },
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: JOB_RUN_STATUSES.FAILED,
                    error_message: 'SL math broke',
                }),
            })
        );
        expect(recordSystemAuditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    status: JOB_RUN_STATUSES.FAILED,
                    error: 'SL math broke',
                }),
            })
        );
    });

    it('throwOnError: re-throws the handler error for the manual-trigger path', async () => {
        createMock.mockResolvedValueOnce({});
        const handler = vi.fn().mockRejectedValue(new Error('boom'));

        await expect(runJob(JOB_NAMES.LEAVE_YEAR_ROLLOVER, '2026', handler, { throwOnError: true })).rejects.toThrow(
            'boom'
        );
    });

    it('non-E11000 lock errors propagate when throwOnError is set', async () => {
        const otherErr = new Error('mongo down');
        createMock.mockRejectedValueOnce(otherErr);

        await expect(runJob(JOB_NAMES.TOKEN_CLEANUP, '2026-W17', vi.fn(), { throwOnError: true })).rejects.toThrow(
            'mongo down'
        );
    });

    // ─── In-tick retry (BACKEND_AUDIT.md P1-6) ──────────────────────────

    it('retries the handler up to maxAttempts before recording failure', async () => {
        createMock.mockResolvedValueOnce({});
        const handler = vi
            .fn()
            .mockRejectedValueOnce(new Error('blip 1'))
            .mockRejectedValueOnce(new Error('blip 2'))
            .mockResolvedValueOnce({ recovered: true });

        // Fake timers so the exponential backoff doesn't actually sleep.
        vi.useFakeTimers();
        const promise = runJob(JOB_NAMES.SL_MONTHLY_FORFEITURE, '2026-04', handler, { maxAttempts: 3 });
        // Drain the two backoff sleeps (1s, 2s).
        await vi.runAllTimersAsync();
        const result = await promise;
        vi.useRealTimers();

        expect(handler).toHaveBeenCalledTimes(3);
        expect(result.status).toBe('success');
        expect(result.summary).toEqual({ recovered: true });
    });

    it('records failure if every retry attempt fails', async () => {
        createMock.mockResolvedValueOnce({});
        const handler = vi.fn().mockRejectedValue(new Error('persistent'));

        vi.useFakeTimers();
        const promise = runJob(JOB_NAMES.LEAVE_YEAR_ROLLOVER, '2026', handler, { maxAttempts: 2 });
        await vi.runAllTimersAsync();
        const result = await promise;
        vi.useRealTimers();

        expect(handler).toHaveBeenCalledTimes(2);
        expect(result.status).toBe('failed');
        expect(result.error).toBe('persistent');
    });

    it('does NOT retry by default (maxAttempts defaults to 1)', async () => {
        createMock.mockResolvedValueOnce({});
        const handler = vi.fn().mockRejectedValue(new Error('one shot'));

        const result = await runJob(JOB_NAMES.TOKEN_CLEANUP, '2026-W17', handler);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('failed');
    });

    // ─── F5 — in-flight registry ────────────────────────────────────────

    it('F5 — registers running runJob promises in the in-flight set, removes on settle', async () => {
        const { getInFlightRunJobs } = await import('./runner.js');
        createMock.mockResolvedValueOnce({});

        let release: () => void = () => {};
        const handler = vi.fn().mockReturnValue(
            new Promise<Record<string, unknown>>((resolve) => {
                release = () => resolve({ ok: true });
            })
        );

        const promise = runJob(JOB_NAMES.TOKEN_CLEANUP, '2026-W17', handler);
        // Mid-handler: the promise is in flight.
        expect(getInFlightRunJobs()).toHaveLength(1);

        release();
        await promise;
        // After settle: registry empty again.
        expect(getInFlightRunJobs()).toHaveLength(0);
    });

    it('F5 — even a failing runJob is removed from the in-flight set', async () => {
        const { getInFlightRunJobs } = await import('./runner.js');
        createMock.mockResolvedValueOnce({});
        const handler = vi.fn().mockRejectedValue(new Error('boom'));

        const promise = runJob(JOB_NAMES.TOKEN_CLEANUP, '2026-W17', handler);
        await promise;

        expect(getInFlightRunJobs()).toHaveLength(0);
    });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for the stuck-job sweeper (BACKEND_AUDIT.md P1-6).
 *
 * Contract:
 *  1. Empty case — no stuck rows → swept: 0, no updateMany.
 *  2. Stuck rows past JOB_LOCK_STALE_MS → marked failed with the
 *     synthetic error_message.
 *  3. The selection filter pins both `status: running` AND
 *     `started_at < (now - stale_ms)` so a recently-started running
 *     job is NOT swept.
 */

const { findMock, updateManyMock, exportFindMock, exportUpdateManyMock } = vi.hoisted(() => ({
    findMock: vi.fn(),
    updateManyMock: vi.fn(),
    exportFindMock: vi.fn(),
    exportUpdateManyMock: vi.fn(),
}));

vi.mock('../models/job-run.model.js', () => ({
    JobRun: {
        find: findMock,
        updateMany: updateManyMock,
    },
}));

vi.mock('../models/report-export.model.js', () => ({
    ReportExport: {
        find: exportFindMock,
        updateMany: exportUpdateManyMock,
    },
}));

vi.mock('../utils/logger.js', () => {
    const child = vi.fn();
    const base = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child };
    child.mockReturnValue(base);
    return { default: base };
});

const { sweepStuckJobs, sweepStuckExports } = await import('./stuck-job-sweeper.job.js');
import { JOB_LOCK_STALE_MS, JOB_RUN_STATUSES } from '../constants/jobs.js';
import { EXPORT_STATUSES } from '../constants/export.js';

const stubFindChain = (rows: unknown[]) =>
    findMock.mockReturnValueOnce({
        select: () => ({
            lean: () => Promise.resolve(rows),
        }),
    });

const stubExportFindChain = (rows: unknown[]) =>
    exportFindMock.mockReturnValueOnce({
        select: () => ({
            lean: () => Promise.resolve(rows),
        }),
    });

beforeEach(() => {
    findMock.mockReset();
    updateManyMock.mockReset();
    exportFindMock.mockReset();
    exportUpdateManyMock.mockReset();
    updateManyMock.mockResolvedValue({ modifiedCount: 0 });
    exportUpdateManyMock.mockResolvedValue({ modifiedCount: 0 });
});

describe('sweepStuckJobs', () => {
    it('returns 0 swept when no rows are stuck', async () => {
        stubFindChain([]);

        const result = await sweepStuckJobs(new Date('2026-05-05T10:00:00Z'));

        expect(result.swept).toBe(0);
        expect(result.jobs).toEqual([]);
        expect(updateManyMock).not.toHaveBeenCalled();
    });

    it('marks stuck rows failed with the auto-failed error_message', async () => {
        const now = new Date('2026-05-05T10:00:00Z');
        // A row that's been "running" for 90 minutes — past the 30 min stale threshold.
        const stuckRow = {
            _id: new Types.ObjectId(),
            name: 'leave_year_rollover',
            run_key: '2026',
            started_at: new Date(now.getTime() - 90 * 60 * 1000),
            host: 'worker-1',
            pid: 4242,
        };
        stubFindChain([stuckRow]);

        const result = await sweepStuckJobs(now);

        expect(result.swept).toBe(1);
        expect(result.jobs[0]).toContain('leave_year_rollover/2026');
        expect(result.jobs[0]).toContain('host=worker-1');
        expect(result.jobs[0]).toContain('pid=4242');
        expect(updateManyMock).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: { $in: [stuckRow._id] },
                status: JOB_RUN_STATUSES.RUNNING,
            }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: JOB_RUN_STATUSES.FAILED,
                    error_message: expect.stringContaining('Auto-failed by stuck_job_sweeper'),
                }),
            })
        );
    });

    it('uses started_at < (now - JOB_LOCK_STALE_MS) as the staleness predicate', async () => {
        const now = new Date('2026-05-05T10:00:00Z');
        stubFindChain([]);

        await sweepStuckJobs(now);

        const filterArg = findMock.mock.calls[0][0] as {
            status: string;
            started_at: { $lt: Date };
        };
        expect(filterArg.status).toBe(JOB_RUN_STATUSES.RUNNING);
        const expectedCutoff = new Date(now.getTime() - JOB_LOCK_STALE_MS);
        expect(filterArg.started_at.$lt.getTime()).toBe(expectedCutoff.getTime());
    });

    it('sweeps multiple stuck rows in one pass', async () => {
        const now = new Date('2026-05-05T10:00:00Z');
        const old = (mins: number) => new Date(now.getTime() - mins * 60 * 1000);
        const rows = [
            {
                _id: new Types.ObjectId(),
                name: 'audit_archive',
                run_key: '2026-05-04',
                started_at: old(120),
                host: 'h1',
                pid: 1,
            },
            {
                _id: new Types.ObjectId(),
                name: 'token_cleanup',
                run_key: '2026-W18',
                started_at: old(60),
                host: 'h2',
                pid: 2,
            },
        ];
        stubFindChain(rows);

        const result = await sweepStuckJobs(now);

        expect(result.swept).toBe(2);
        expect(result.jobs).toHaveLength(2);
        const updateArg = updateManyMock.mock.calls[0][0] as { _id: { $in: Types.ObjectId[] } };
        expect(updateArg._id.$in).toHaveLength(2);
    });
});

// ─── T9 — sweepStuckExports ────────────────────────────────────────────

describe('sweepStuckExports (T9)', () => {
    it('returns 0 swept when no export rows are stuck', async () => {
        stubExportFindChain([]);

        const result = await sweepStuckExports(new Date('2026-05-05T10:00:00Z'));

        expect(result.swept).toBe(0);
        expect(result.ids).toEqual([]);
        expect(exportUpdateManyMock).not.toHaveBeenCalled();
    });

    it('marks stuck export rows failed with the auto-failed error_message + JOB_RUN_FAILED code', async () => {
        const now = new Date('2026-05-05T10:00:00Z');
        const stuckExport = {
            _id: new Types.ObjectId(),
            requested_by_user_id: new Types.ObjectId(),
            report_name: 'billing',
            format: 'pdf',
            // 90 minutes ago — past the 30 min threshold.
            started_at: new Date(now.getTime() - 90 * 60 * 1000),
        };
        stubExportFindChain([stuckExport]);

        const result = await sweepStuckExports(now);

        expect(result.swept).toBe(1);
        expect(result.ids).toEqual([stuckExport._id.toString()]);
        expect(exportUpdateManyMock).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: { $in: [stuckExport._id] },
                status: EXPORT_STATUSES.RUNNING,
            }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: EXPORT_STATUSES.FAILED,
                    error_message: expect.stringContaining('Auto-failed by stuck_job_sweeper'),
                    error_code: 'JOB_RUN_FAILED',
                }),
            })
        );
    });

    it('uses started_at < (now - threshold) as the staleness predicate', async () => {
        const now = new Date('2026-05-05T10:00:00Z');
        stubExportFindChain([]);

        await sweepStuckExports(now);

        const filterArg = exportFindMock.mock.calls[0][0] as {
            status: string;
            started_at: { $lt: Date };
        };
        expect(filterArg.status).toBe(EXPORT_STATUSES.RUNNING);
        // Threshold is JOB_LOCK_STALE_MS by design (re-uses the
        // sweep-eligibility window).
        const expectedCutoff = new Date(now.getTime() - JOB_LOCK_STALE_MS);
        expect(filterArg.started_at.$lt.getTime()).toBe(expectedCutoff.getTime());
    });
});

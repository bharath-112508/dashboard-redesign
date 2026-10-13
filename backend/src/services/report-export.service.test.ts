import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ERROR_CODES } from '../constants/error-codes.js';
import { EXPORT_STATUSES } from '../constants/export.js';
import { AUDIT_ACTIONS } from '../constants/audit.js';

/**
 * Unit tests for `report-export.service` (Step 30).
 *
 * Coverage focus:
 *   1. **enqueueExport** — creates a `pending` row, writes an audit row
 *      (when caller has audit context), schedules the worker, returns
 *      `{id, status}`.
 *   2. **runExport happy path** — flips pending→running, builds the
 *      report, generates bytes, uploads, flips running→ready, writes
 *      a system audit.
 *   3. **runExport — Azure not configured** — flips to `failed` with
 *      `STORAGE_NOT_CONFIGURED`.
 *   4. **runExport — PDF deferred** — flips to `failed` with
 *      `EXPORT_PDF_NOT_AVAILABLE`.
 *   5. **runExport — concurrent re-entry** — second call after the
 *      atomic `pending→running` flip is a no-op (no double-generate).
 *   6. **getExport** — owner-scoped 404; on `ready`, mints a fresh
 *      download SAS each call.
 *   7. **cleanupExpiredExports** — deletes expired rows + best-effort
 *      blobs.
 */

const {
    reportExportCreateMock,
    reportExportFindOneAndUpdateMock,
    reportExportFindByIdAndUpdateMock,
    reportExportFindOneMock,
    reportExportFindMock,
    reportExportDeleteManyMock,
    isAzureConfiguredMock,
    putBlobMock,
    deleteBlobMock,
    mintDownloadSasMock,
    recordAuditMock,
    recordSystemAuditMock,
    buildBillingReportMock,
    buildUtilizationReportMock,
    buildAttendanceReportMock,
    buildLeaveReportMock,
} = vi.hoisted(() => ({
    reportExportCreateMock: vi.fn(),
    reportExportFindOneAndUpdateMock: vi.fn(),
    reportExportFindByIdAndUpdateMock: vi.fn(),
    reportExportFindOneMock: vi.fn(),
    reportExportFindMock: vi.fn(),
    reportExportDeleteManyMock: vi.fn(),
    isAzureConfiguredMock: vi.fn(),
    putBlobMock: vi.fn(),
    deleteBlobMock: vi.fn(),
    mintDownloadSasMock: vi.fn(),
    recordAuditMock: vi.fn(),
    recordSystemAuditMock: vi.fn(),
    buildBillingReportMock: vi.fn(),
    buildUtilizationReportMock: vi.fn(),
    buildAttendanceReportMock: vi.fn(),
    buildLeaveReportMock: vi.fn(),
}));

vi.mock('../models/report-export.model.js', () => ({
    ReportExport: {
        create: reportExportCreateMock,
        findOneAndUpdate: reportExportFindOneAndUpdateMock,
        findByIdAndUpdate: reportExportFindByIdAndUpdateMock,
        findOne: reportExportFindOneMock,
        find: reportExportFindMock,
        deleteMany: reportExportDeleteManyMock,
    },
}));

vi.mock('../utils/azure-blob.js', () => ({
    isAzureConfigured: isAzureConfiguredMock,
    putBlob: putBlobMock,
    deleteBlob: deleteBlobMock,
    mintDownloadSas: mintDownloadSasMock,
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: recordSystemAuditMock,
}));

vi.mock('./report.service.js', () => ({
    buildBillingReport: buildBillingReportMock,
    buildUtilizationReport: buildUtilizationReportMock,
    buildAttendanceReport: buildAttendanceReportMock,
    buildLeaveReport: buildLeaveReportMock,
}));

const svc = await import('./report-export.service.js');

// ─── Helpers ────────────────────────────────────────────────────────────

const makeCaller = () => ({
    id: new Types.ObjectId(),
    audit: {
        actor_id: new Types.ObjectId(),
        actor_role: 'admin' as const,
        ip: null,
        user_agent: null,
        request_id: null,
    },
});

const makeRow = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    requested_by_user_id: new Types.ObjectId(),
    report_name: 'billing' as const,
    format: 'csv' as const,
    filters: { project_id: 'p1', from_date: '2026-04-01', to_date: '2026-04-30' },
    status: EXPORT_STATUSES.PENDING,
    blob_container: null,
    blob_key: null,
    file_size_bytes: null,
    error_message: null,
    error_code: null,
    started_at: null,
    completed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    created_at: new Date('2026-04-30T10:00:00Z'),
    ...overrides,
});

const billingReportFixture = () => ({
    project: { id: 'p1', name: 'Apollo' },
    from_date: '2026-04-01',
    to_date: '2026-04-30',
    rows: [
        {
            user: { id: 'u1', full_name: 'Anna' },
            task: { id: 't1', title: 'Build' },
            billable_minutes: 600,
            non_billable_minutes: 0,
            hourly_rate: 2500,
            billable_amount: 25000,
        },
    ],
    totals: { billable_minutes: 600, non_billable_minutes: 0, billable_amount: 25000 },
});

beforeEach(() => {
    vi.resetAllMocks();
    // setImmediate would race the assertions; force inline worker dispatch.
    process.env.EXPORT_WORKER_INLINE = 'true';
    // Default — Azure unconfigured-by-default would trip every happy-path
    // test; flip on per-test as needed.
    isAzureConfiguredMock.mockReturnValue(true);
    putBlobMock.mockResolvedValue({ size: 123 });
    deleteBlobMock.mockResolvedValue(undefined);
    mintDownloadSasMock.mockReturnValue({
        url: 'https://blob.example/test?sas=abc',
        expires_at: new Date('2026-05-01T00:00:00Z'),
    });
    recordAuditMock.mockResolvedValue(undefined);
    recordSystemAuditMock.mockResolvedValue(undefined);
    reportExportFindByIdAndUpdateMock.mockResolvedValue(null);
});

// ─── enqueueExport ──────────────────────────────────────────────────────

describe('enqueueExport', () => {
    it('creates a pending row, audits the create, returns {id, status: pending}', async () => {
        const row = makeRow();
        reportExportCreateMock.mockResolvedValueOnce(row);
        // Worker tick will fire inline — happy-path mocks below.
        reportExportFindOneAndUpdateMock.mockResolvedValueOnce(makeRow({ status: EXPORT_STATUSES.RUNNING }));
        buildBillingReportMock.mockResolvedValueOnce(billingReportFixture());

        const caller = makeCaller();
        const result = await svc.enqueueExport(
            { name: 'billing', format: 'csv', filters: { project_id: 'p1' } },
            caller
        );

        expect(result).toEqual({ id: row._id.toString(), status: EXPORT_STATUSES.PENDING });

        const createArg = reportExportCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(createArg.report_name).toBe('billing');
        expect(createArg.format).toBe('csv');
        expect(createArg.status).toBe(EXPORT_STATUSES.PENDING);
        expect(createArg.expires_at).toBeInstanceOf(Date);

        // Audit row created with REPORT_EXPORT_CREATE action.
        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const auditInput = recordAuditMock.mock.calls[0][1] as { action: string };
        expect(auditInput.action).toBe(AUDIT_ACTIONS.REPORT_EXPORT_CREATE);
    });

    it('omits the audit when caller has no audit context', async () => {
        const row = makeRow();
        reportExportCreateMock.mockResolvedValueOnce(row);
        reportExportFindOneAndUpdateMock.mockResolvedValueOnce(null); // worker no-op

        await svc.enqueueExport(
            { name: 'billing', format: 'csv', filters: {} },
            { id: new Types.ObjectId() } // no `audit` field
        );

        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── runExport — happy path ─────────────────────────────────────────────

describe('runExport (happy path)', () => {
    it('flips pending→running→ready, generates bytes, uploads, audits complete', async () => {
        const row = makeRow();
        reportExportFindOneAndUpdateMock.mockResolvedValueOnce(row);
        buildBillingReportMock.mockResolvedValueOnce(billingReportFixture());

        await svc.runExport(row._id);

        // Atomic flip filter shape: {_id, status: pending} → set running.
        const flipFilter = reportExportFindOneAndUpdateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(flipFilter._id).toEqual(row._id);
        expect(flipFilter.status).toBe(EXPORT_STATUSES.PENDING);

        // Upload happened with the right container + content-type.
        expect(putBlobMock).toHaveBeenCalledTimes(1);
        const uploadArgs = putBlobMock.mock.calls[0][0] as Record<string, unknown>;
        expect(uploadArgs.container).toBe('report-exports');
        expect(uploadArgs.contentType).toBe('text/csv');
        expect(uploadArgs.blobKey).toMatch(/^exports\/.+\.csv$/);

        // Final state: ready.
        const readyUpdate = reportExportFindByIdAndUpdateMock.mock.calls.find(
            (c) => (c[1] as { $set: { status: string } }).$set.status === EXPORT_STATUSES.READY
        );
        expect(readyUpdate).toBeDefined();

        // System audit on complete.
        const completeCall = recordSystemAuditMock.mock.calls.find(
            (c) => (c[0] as { action: string }).action === AUDIT_ACTIONS.REPORT_EXPORT_COMPLETE
        );
        expect(completeCall).toBeDefined();
    });
});

// ─── runExport — failure paths ──────────────────────────────────────────

describe('runExport (failure paths)', () => {
    it('marks failed with STORAGE_NOT_CONFIGURED when Azure is off', async () => {
        const row = makeRow();
        reportExportFindOneAndUpdateMock.mockResolvedValueOnce(row);
        isAzureConfiguredMock.mockReturnValue(false);

        await svc.runExport(row._id);

        const failedCall = reportExportFindByIdAndUpdateMock.mock.calls.find(
            (c) => (c[1] as { $set: { status: string } }).$set.status === EXPORT_STATUSES.FAILED
        );
        expect(failedCall).toBeDefined();
        const set = (failedCall![1] as { $set: { error_code: string } }).$set;
        expect(set.error_code).toBe(ERROR_CODES.STORAGE_NOT_CONFIGURED);

        // System audit fired with REPORT_EXPORT_FAIL.
        const failAudit = recordSystemAuditMock.mock.calls.find(
            (c) => (c[0] as { action: string }).action === AUDIT_ACTIONS.REPORT_EXPORT_FAIL
        );
        expect(failAudit).toBeDefined();

        // Upload never attempted.
        expect(putBlobMock).not.toHaveBeenCalled();
    });

    it('PDF format now succeeds via the default pdfkit engine (Step-30 follow-up landed)', async () => {
        // Phase-4 cleanup — the legacy `EXPORT_PDF_NOT_AVAILABLE`
        // stub was replaced by the pluggable generator factory
        // (`pdf-generators/`). The default `pdfkit` engine works on
        // any Node deploy without infra changes, so a `format: 'pdf'`
        // request now produces a real PDF and uploads it. The
        // fail-with-EXPORT_PDF_NOT_AVAILABLE path is still wired —
        // it surfaces only when a future config selects the
        // `puppeteer` engine without the package installed.
        const row = makeRow({ format: 'pdf' });
        reportExportFindOneAndUpdateMock.mockResolvedValueOnce(row);
        buildBillingReportMock.mockResolvedValueOnce(billingReportFixture());

        await svc.runExport(row._id);

        const readyUpdate = reportExportFindByIdAndUpdateMock.mock.calls.find(
            (c) => (c[1] as { $set: { status: string } }).$set.status === EXPORT_STATUSES.READY
        );
        expect(readyUpdate).toBeDefined();
        // The blob upload happened — verifies the generator returned
        // a non-empty buffer the worker actually shipped.
        expect(putBlobMock).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the row was already flipped past pending (concurrent worker)', async () => {
        // Atomic findOneAndUpdate returns null when filter (status=pending) misses.
        reportExportFindOneAndUpdateMock.mockResolvedValueOnce(null);
        await svc.runExport(new Types.ObjectId());

        expect(buildBillingReportMock).not.toHaveBeenCalled();
        expect(putBlobMock).not.toHaveBeenCalled();
        expect(reportExportFindByIdAndUpdateMock).not.toHaveBeenCalled();
    });
});

// ─── getExport ──────────────────────────────────────────────────────────

describe('getExport', () => {
    it('throws EXPORT_NOT_FOUND when the row is missing or owned by another user', async () => {
        reportExportFindOneMock.mockResolvedValueOnce(null);
        await expect(svc.getExport(new Types.ObjectId(), makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.EXPORT_NOT_FOUND,
        });
        // Filter must include requested_by_user_id so cross-user IDs are 404.
        const filter = reportExportFindOneMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.requested_by_user_id).toBeDefined();
    });

    it('mints a fresh download SAS on every ready read (no SAS persistence)', async () => {
        const row = makeRow({
            status: EXPORT_STATUSES.READY,
            blob_container: 'report-exports',
            blob_key: 'exports/abc.csv',
            file_size_bytes: 123,
            completed_at: new Date(),
        });
        reportExportFindOneMock.mockResolvedValueOnce(row);

        const snap = await svc.getExport(row._id, makeCaller());

        expect(snap.status).toBe(EXPORT_STATUSES.READY);
        expect(snap.download_url).toBe('https://blob.example/test?sas=abc');
        expect(snap.download_url_expires_at).toBe('2026-05-01T00:00:00.000Z');
        expect(mintDownloadSasMock).toHaveBeenCalledTimes(1);
        const sasArgs = mintDownloadSasMock.mock.calls[0][0] as Record<string, unknown>;
        expect(sasArgs.container).toBe('report-exports');
        expect(sasArgs.blobKey).toBe('exports/abc.csv');
    });

    it('returns null download_url when status != ready (FE polls again)', async () => {
        const row = makeRow({ status: EXPORT_STATUSES.RUNNING });
        reportExportFindOneMock.mockResolvedValueOnce(row);
        const snap = await svc.getExport(row._id, makeCaller());
        expect(snap.download_url).toBeNull();
        expect(mintDownloadSasMock).not.toHaveBeenCalled();
    });

    it('surfaces error_message + error_code on failed exports', async () => {
        const row = makeRow({
            status: EXPORT_STATUSES.FAILED,
            error_message: 'Azure Blob storage is not configured',
            error_code: ERROR_CODES.STORAGE_NOT_CONFIGURED,
            completed_at: new Date(),
        });
        reportExportFindOneMock.mockResolvedValueOnce(row);
        const snap = await svc.getExport(row._id, makeCaller());
        expect(snap.status).toBe(EXPORT_STATUSES.FAILED);
        expect(snap.error_code).toBe(ERROR_CODES.STORAGE_NOT_CONFIGURED);
        expect(snap.download_url).toBeNull();
    });
});

// ─── cleanupExpiredExports ──────────────────────────────────────────────

describe('cleanupExpiredExports', () => {
    const queryStub = (rows: unknown[]) => {
        const stub: Record<string, unknown> = {
            select: () => stub,
            lean: () => Promise.resolve(rows),
        };
        return stub;
    };

    it('deletes expired rows and best-effort wipes the underlying blobs', async () => {
        const expiredRows = [
            { _id: new Types.ObjectId(), blob_container: 'report-exports', blob_key: 'exports/a.csv' },
            { _id: new Types.ObjectId(), blob_container: 'report-exports', blob_key: 'exports/b.xlsx' },
            // A row that never made it past pending — no blob to delete.
            { _id: new Types.ObjectId(), blob_container: null, blob_key: null },
        ];
        reportExportFindMock.mockReturnValueOnce(queryStub(expiredRows));
        reportExportDeleteManyMock.mockResolvedValueOnce({ deletedCount: 3 });

        const summary = await svc.cleanupExpiredExports(new Date('2026-05-08'));

        expect(summary.rows_deleted).toBe(3);
        expect(summary.blobs_deleted).toBe(2);
        expect(deleteBlobMock).toHaveBeenCalledTimes(2);
    });

    it('skips blob deletes when Azure is unconfigured (rows still purged)', async () => {
        isAzureConfiguredMock.mockReturnValue(false);
        const expired = [{ _id: new Types.ObjectId(), blob_container: 'c', blob_key: 'k' }];
        reportExportFindMock.mockReturnValueOnce(queryStub(expired));
        reportExportDeleteManyMock.mockResolvedValueOnce({ deletedCount: 1 });

        const summary = await svc.cleanupExpiredExports(new Date());

        expect(deleteBlobMock).not.toHaveBeenCalled();
        expect(summary.blobs_deleted).toBe(0);
        expect(summary.rows_deleted).toBe(1);
    });

    it('returns zero counts when there is nothing to clean up', async () => {
        reportExportFindMock.mockReturnValueOnce(queryStub([]));
        const summary = await svc.cleanupExpiredExports(new Date());
        expect(summary).toEqual({ rows_deleted: 0, blobs_deleted: 0 });
        expect(reportExportDeleteManyMock).not.toHaveBeenCalled();
    });
});

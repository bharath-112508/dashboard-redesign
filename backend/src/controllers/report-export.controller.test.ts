import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * Step 30 final-check regression: the global error handler does NOT
 * convert raw `ZodError` to `AppError.validation` (it'd be a 500
 * INTERNAL_ERROR). The export POST controller can't use the
 * `validate({ body })` middleware because the filter schema is
 * dispatched on `:name`, so it parses the body inline and must catch
 * + wrap the ZodError itself.
 *
 * These tests pin that wrap so a future controller refactor can't
 * silently regress to 500-on-bad-body.
 */

const { enqueueExportMock, getExportMock } = vi.hoisted(() => ({
    enqueueExportMock: vi.fn(),
    getExportMock: vi.fn(),
}));

vi.mock('../services/report-export.service.js', () => ({
    enqueueExport: enqueueExportMock,
    getExport: getExportMock,
}));

// The controller branches on `isAzureConfigured()`: configured → enqueue an
// async export and answer 202; not configured → render inline and stream the
// file back. These tests are about the ZodError wrap, not that branch, so pin
// it rather than letting the ambient environment choose. Unpinned, the suite
// passed on a developer machine with Azure credentials in `.env` and failed in
// CI, where the fallback path calls a `generateExportInline` the mock above
// never provided.
vi.mock('../utils/azure-blob.js', () => ({
    isAzureConfigured: () => true,
}));

vi.mock('../utils/audit-context.js', () => ({
    buildAuditContext: () => ({
        actor_id: new Types.ObjectId(),
        actor_role: 'admin',
        ip: null,
        user_agent: null,
        request_id: null,
    }),
}));

const ctrl = await import('./report-export.controller.js');

const makeReq = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    user: { user_id: new Types.ObjectId().toString() },
    params: { name: 'billing' },
    body: {
        format: 'csv',
        filters: {
            project_id: 'a'.repeat(24),
            from_date: '2026-04-01',
            to_date: '2026-04-30',
        },
    },
    ...overrides,
});

const makeRes = () => ({
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
});

beforeEach(() => {
    vi.resetAllMocks();
});

describe('postExport', () => {
    it('forwards a valid body to the service and returns 202', async () => {
        enqueueExportMock.mockResolvedValueOnce({ id: 'abc', status: 'pending' });

        const req = makeReq();
        const res = makeRes();
        await ctrl.postExport(req as never, res as never);

        expect(enqueueExportMock).toHaveBeenCalledTimes(1);
        const [{ name, format, filters }] = enqueueExportMock.mock.calls[0] as [
            { name: string; format: string; filters: Record<string, unknown> },
        ];
        expect(name).toBe('billing');
        expect(format).toBe('csv');
        expect(filters.project_id).toBe('a'.repeat(24));

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith({ data: { id: 'abc', status: 'pending' } });
    });

    it('converts a malformed body (ZodError) into AppError.validation (NOT 500)', async () => {
        const req = makeReq({ body: { format: 'docx', filters: {} } }); // bad format
        const res = makeRes();

        // The controller wraps the ZodError in AppError.validation; that
        // surfaces as a thrown error with `code: VALIDATION_ERROR` and
        // `details.errors[]`. The asyncHandler re-throws to the global
        // error handler which renders the 400 body.
        await expect(ctrl.postExport(req as never, res as never)).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
        expect(enqueueExportMock).not.toHaveBeenCalled();
    });

    it('converts a body whose filter shape mismatches :name (cross-name) to VALIDATION_ERROR', async () => {
        // Billing filters under the leaves report — strict schema rejects.
        const req = makeReq({
            params: { name: 'leaves' },
            body: {
                format: 'csv',
                filters: { project_id: 'a'.repeat(24), from_date: '2026-04-01', to_date: '2026-04-30' },
            },
        });
        const res = makeRes();
        await expect(ctrl.postExport(req as never, res as never)).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
    });
});

describe('getExportStatus', () => {
    it('forwards :id + caller to the service and returns the snapshot', async () => {
        const id = new Types.ObjectId();
        getExportMock.mockResolvedValueOnce({ id: id.toString(), status: 'ready' });

        const req = makeReq({ params: { id: id.toString() } });
        const res = makeRes();
        await ctrl.getExportStatus(req as never, res as never);

        expect(getExportMock).toHaveBeenCalledTimes(1);
        const [calledId] = getExportMock.mock.calls[0] as [Types.ObjectId];
        expect(calledId.toString()).toBe(id.toString());
        expect(res.json).toHaveBeenCalledWith({ data: { id: id.toString(), status: 'ready' } });
    });
});

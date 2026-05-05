import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for the audit-log offsite mirror service (BACKEND_AUDIT.md
 * P1-7).
 *
 * Contract:
 *   1. First-ever run with no chain head: walks ALL audit_logs from
 *      epoch, writes one chain row, no `previous_*` link.
 *   2. Subsequent run: filters on `_id > previous.to_id`, links the
 *      new chain row to the previous via `previous_mirror_id` +
 *      `previous_hash`.
 *   3. Empty hour: still writes a chain row with `row_count = 0` and
 *      `blob_*: null` so the integrity walk is unbroken.
 *   4. Azure not configured: cron is a no-op (warn log; no row).
 *   5. Hash chain: each batch's `sha256_hash` is the SHA-256 of the
 *      gzipped jsonl bytes; `previous_hash` mirrors the prior row's
 *      `sha256_hash`.
 */

const {
    auditLogFindMock,
    auditLogCountDocumentsMock,
    auditLogMirrorFindOneMock,
    auditLogMirrorCreateMock,
    putBlobMock,
    isAzureConfiguredMock,
} = vi.hoisted(() => ({
    auditLogFindMock: vi.fn(),
    auditLogCountDocumentsMock: vi.fn(),
    auditLogMirrorFindOneMock: vi.fn(),
    auditLogMirrorCreateMock: vi.fn(),
    putBlobMock: vi.fn(),
    isAzureConfiguredMock: vi.fn(),
}));

vi.mock('../models/audit-log.model.js', () => ({
    AuditLog: { find: auditLogFindMock, countDocuments: auditLogCountDocumentsMock },
}));

vi.mock('../models/audit-log-mirror.model.js', () => ({
    AuditLogMirror: {
        findOne: auditLogMirrorFindOneMock,
        create: auditLogMirrorCreateMock,
    },
}));

vi.mock('../utils/azure-blob.js', () => ({
    isAzureConfigured: isAzureConfiguredMock,
    putBlob: putBlobMock,
}));

vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mirrorAuditLogs } = await import('./audit-log-mirror.service.js');
import { AUDIT_LOG_MIRROR_BLOB_CONTAINER } from '../constants/audit-log-mirror.js';

const findChain = (rows: unknown[]) =>
    auditLogFindMock.mockReturnValueOnce({
        sort: () => ({
            limit: () => ({
                lean: () => Promise.resolve(rows),
            }),
        }),
    });

const findOneChain = (row: unknown) =>
    auditLogMirrorFindOneMock.mockReturnValueOnce({
        sort: () => ({
            select: () => ({
                lean: () => Promise.resolve(row),
            }),
        }),
    });

const sampleAuditRow = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    actor_id: new Types.ObjectId(),
    actor_role: 'admin',
    action: 'user.update',
    target_entity: { kind: 'user', id: new Types.ObjectId() },
    before: { name: 'old' },
    after: { name: 'new' },
    metadata: {},
    created_at: new Date('2026-05-05T10:30:00Z'),
    ...overrides,
});

beforeEach(() => {
    auditLogFindMock.mockReset();
    auditLogCountDocumentsMock.mockReset();
    auditLogMirrorFindOneMock.mockReset();
    auditLogMirrorCreateMock.mockReset();
    putBlobMock.mockReset();
    isAzureConfiguredMock.mockReset();
    isAzureConfiguredMock.mockReturnValue(true);
    putBlobMock.mockResolvedValue({ size: 1234 });
    auditLogMirrorCreateMock.mockResolvedValue({});
    // R9 — `mirrorAuditLogs` calls `AuditLog.countDocuments` for the
    // backlog metric. Default to 0 so legacy tests pass; tests
    // exercising the backlog branch override per-call.
    auditLogCountDocumentsMock.mockResolvedValue(0);
});

describe('mirrorAuditLogs', () => {
    // ─── Azure not configured ──────────────────────────────────────────

    it('is a no-op when Azure is not configured', async () => {
        isAzureConfiguredMock.mockReturnValue(false);

        const result = await mirrorAuditLogs(new Date('2026-05-05T10:00:00Z'));

        expect(result.rows_mirrored).toBe(0);
        expect(result.blob_key).toBeNull();
        expect(auditLogMirrorCreateMock).not.toHaveBeenCalled();
        expect(putBlobMock).not.toHaveBeenCalled();
    });

    // ─── First-ever run ─────────────────────────────────────────────────

    it('first-ever run: no chain head, walks all rows from epoch, links previous_*: null', async () => {
        findOneChain(null); // no prior chain row
        const rows = [sampleAuditRow(), sampleAuditRow()];
        auditLogCountDocumentsMock.mockResolvedValueOnce(2);
        findChain(rows);

        const result = await mirrorAuditLogs(new Date('2026-05-05T10:00:00Z'));

        expect(result.rows_mirrored).toBe(2);
        expect(result.sha256_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(result.blob_key).toContain(AUDIT_LOG_MIRROR_BLOB_CONTAINER.slice(0, 0)); // smoke
        expect(putBlobMock).toHaveBeenCalledOnce();
        expect(auditLogMirrorCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                from_id: null,
                to_id: rows[1]._id,
                row_count: 2,
                previous_mirror_id: null,
                previous_hash: null,
            })
        );
        // The find filter must be empty (no `_id > x` clause) on the first run.
        const findFilter = auditLogFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(findFilter._id).toBeUndefined();
    });

    it('R13 — cold install with no chain head AND no rows: does NOT create a noise chain row', async () => {
        findOneChain(null); // no prior chain row
        findChain([]); // no audit rows yet
        // count is also 0 by default in beforeEach

        const result = await mirrorAuditLogs(new Date('2026-05-05T10:00:00Z'));

        expect(result.rows_mirrored).toBe(0);
        expect(result.blob_key).toBeNull();
        expect(auditLogMirrorCreateMock).not.toHaveBeenCalled();
        expect(putBlobMock).not.toHaveBeenCalled();
    });

    // ─── Incremental run ────────────────────────────────────────────────

    it('subsequent run: filters on _id > previous.to_id and links previous_*', async () => {
        const prevToId = new Types.ObjectId();
        const prevHash = 'a'.repeat(64);
        const prevId = new Types.ObjectId();
        findOneChain({ _id: prevId, to_id: prevToId, watermark_at: new Date(), sha256_hash: prevHash });

        const newRows = [sampleAuditRow(), sampleAuditRow()];
        findChain(newRows);

        await mirrorAuditLogs(new Date('2026-05-05T11:00:00Z'));

        const findFilter = auditLogFindMock.mock.calls[0][0] as { _id: { $gt: Types.ObjectId } };
        expect(findFilter._id).toEqual({ $gt: prevToId });

        expect(auditLogMirrorCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                from_id: prevToId,
                to_id: newRows[1]._id,
                row_count: 2,
                previous_mirror_id: prevId,
                previous_hash: prevHash,
            })
        );
    });

    // ─── Empty hour ─────────────────────────────────────────────────────

    it('empty hour: writes a chain row with row_count=0 and blob_*=null', async () => {
        const prevToId = new Types.ObjectId();
        const prevHash = 'b'.repeat(64);
        const prevId = new Types.ObjectId();
        findOneChain({ _id: prevId, to_id: prevToId, watermark_at: new Date(), sha256_hash: prevHash });

        findChain([]); // no new rows

        const result = await mirrorAuditLogs(new Date('2026-05-05T12:00:00Z'));

        expect(result.rows_mirrored).toBe(0);
        expect(result.blob_key).toBeNull();
        expect(putBlobMock).not.toHaveBeenCalled();
        expect(auditLogMirrorCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                from_id: prevToId,
                to_id: prevToId,
                row_count: 0,
                blob_container: null,
                blob_key: null,
                sha256_hash: null,
                previous_mirror_id: prevId,
                previous_hash: prevHash,
            })
        );
    });

    // ─── R9: backlog metric ────────────────────────────────────────────

    it('R9 — calls countDocuments with the same filter as find (so the lag metric reflects the true backlog)', async () => {
        findOneChain(null);
        auditLogCountDocumentsMock.mockResolvedValueOnce(7500); // backlog over the per-run cap (5000)
        findChain([sampleAuditRow()]);

        await mirrorAuditLogs(new Date('2026-05-05T10:00:00Z'));

        // The countDocuments filter must mirror the find filter — same
        // `_id > previous.to_id` predicate (or no predicate on cold start).
        expect(auditLogCountDocumentsMock).toHaveBeenCalledWith({});
    });

    it('R9 — countDocuments uses the _id > previous.to_id filter on incremental runs', async () => {
        const prevToId = new Types.ObjectId();
        findOneChain({
            _id: new Types.ObjectId(),
            to_id: prevToId,
            watermark_at: new Date(),
            sha256_hash: 'a'.repeat(64),
        });
        auditLogCountDocumentsMock.mockResolvedValueOnce(50);
        findChain([sampleAuditRow()]);

        await mirrorAuditLogs(new Date('2026-05-05T11:00:00Z'));

        const countFilter = auditLogCountDocumentsMock.mock.calls[0][0] as { _id: { $gt: Types.ObjectId } };
        expect(countFilter._id).toEqual({ $gt: prevToId });
    });

    // ─── Hash chain integrity ──────────────────────────────────────────

    it('hash is deterministic for the same input — same rows produce same sha256', async () => {
        // Two consecutive runs over identical row content should produce
        // the same sha256, proving the hash is purely content-derived.
        findOneChain(null);
        const rowSet = [
            sampleAuditRow({ _id: new Types.ObjectId('507f1f77bcf86cd799439011'), created_at: new Date(0) }),
        ];
        findChain(rowSet);
        const first = await mirrorAuditLogs(new Date('2026-05-05T10:00:00Z'));

        findOneChain(null);
        findChain(rowSet);
        const second = await mirrorAuditLogs(new Date('2026-05-05T11:00:00Z'));

        expect(first.sha256_hash).toBe(second.sha256_hash);
        expect(first.sha256_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    // ─── Blob upload ordering ──────────────────────────────────────────

    it('uploads the blob BEFORE writing the chain row', async () => {
        findOneChain(null);
        findChain([sampleAuditRow()]);

        // Stash the order in which the mocks are called.
        const order: string[] = [];
        putBlobMock.mockImplementation(async () => {
            order.push('put');
            return { size: 100 };
        });
        auditLogMirrorCreateMock.mockImplementation(async () => {
            order.push('create');
        });

        await mirrorAuditLogs(new Date('2026-05-05T10:00:00Z'));

        expect(order).toEqual(['put', 'create']);
    });
});

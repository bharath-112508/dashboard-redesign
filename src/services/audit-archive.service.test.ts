import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * Unit tests for `audit-archive.service` (Phase 4 Step 39).
 *
 * Coverage focus:
 *   1. **archiveDay happy path** — yields a gzipped JSONL file whose
 *      SHA-256 matches what's stored on the chain row; rows in
 *      `audit_logs` are deleted after the upload + row-create succeed.
 *   2. **Hash chain link** — the new archive's `previous_archive_*`
 *      points at the most recent existing archive.
 *   3. **Empty-day shortcut** — a date with zero rows still writes a
 *      chain row (with `row_count = 0`, no blob upload, no Mongo
 *      delete) so the integrity walk has no gaps.
 *   4. **already-archived dedup** — a second `archiveDay` for the same
 *      date is a no-op.
 *   5. **runArchivalSweep catch-up cap** — at most `MAX_DAYS_PER_RUN`
 *      candidate dates are considered per tick.
 *   6. **verifyArchive** — `ok` for a matching hash; `hash_mismatch`
 *      for a tampered file; `blob_missing` for a deleted blob;
 *      `empty_archive` for a row_count=0 archive.
 *   7. **listArchives filter shape** — date-range filter maps to
 *      `archive_date` $gte/$lte; pagination skip/limit math.
 */

const {
    auditLogFindMock,
    auditLogDeleteManyMock,
    archiveFindOneMock,
    archiveFindByIdMock,
    archiveFindMock,
    archiveCountMock,
    archiveCreateMock,
    isAzureConfiguredMock,
    putBlobMock,
    downloadBlobMock,
    mintDownloadSasMock,
} = vi.hoisted(() => ({
    auditLogFindMock: vi.fn(),
    auditLogDeleteManyMock: vi.fn(),
    archiveFindOneMock: vi.fn(),
    archiveFindByIdMock: vi.fn(),
    archiveFindMock: vi.fn(),
    archiveCountMock: vi.fn(),
    archiveCreateMock: vi.fn(),
    isAzureConfiguredMock: vi.fn(),
    putBlobMock: vi.fn(),
    downloadBlobMock: vi.fn(),
    mintDownloadSasMock: vi.fn(),
}));

vi.mock('../models/audit-log.model.js', () => ({
    AuditLog: {
        find: auditLogFindMock,
        deleteMany: auditLogDeleteManyMock,
    },
}));

vi.mock('../models/audit-archive.model.js', () => ({
    AuditArchive: {
        findOne: archiveFindOneMock,
        findById: archiveFindByIdMock,
        find: archiveFindMock,
        countDocuments: archiveCountMock,
        create: archiveCreateMock,
    },
}));

vi.mock('../utils/azure-blob.js', async () => {
    const actual = await vi.importActual<typeof import('../utils/azure-blob.js')>('../utils/azure-blob.js');
    return {
        ...actual,
        isAzureConfigured: isAzureConfiguredMock,
        putBlob: putBlobMock,
        downloadBlob: downloadBlobMock,
        mintDownloadSas: mintDownloadSasMock,
    };
});

const svc = await import('./audit-archive.service.js');

// ─── Helpers ─────────────────────────────────────────────────────────────

const auditRow = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    actor_id: new Types.ObjectId(),
    actor_role: 'admin',
    action: 'user.deactivate',
    target_entity: { kind: 'user', id: new Types.ObjectId() },
    before: null,
    after: null,
    metadata: {},
    created_at: new Date('2026-01-01T10:00:00Z'),
    ...overrides,
});

const cursorStub = (rows: unknown[]) => {
    return {
        sort: () => cursorStub(rows),
        lean: () => cursorStub(rows),
        cursor: () => ({
            [Symbol.asyncIterator]: async function* () {
                for (const r of rows) yield r;
            },
        }),
    };
};

const findOneStub = (row: unknown) => ({
    lean: () => Promise.resolve(row),
    sort: () => findOneStub(row),
    then: (r: (v: unknown) => void) => Promise.resolve(row).then(r),
});

const queryStub = (rows: unknown[]) => {
    const stub: Record<string, unknown> = {
        sort: () => stub,
        skip: () => stub,
        limit: () => stub,
        then: (r: (v: unknown) => void) => Promise.resolve(rows).then(r),
    };
    return stub;
};

beforeEach(() => {
    vi.resetAllMocks();
    isAzureConfiguredMock.mockReturnValue(true);
    putBlobMock.mockResolvedValue({ size: 0 });
    auditLogDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    mintDownloadSasMock.mockReturnValue({
        url: 'https://blob.example/test?sas=abc',
        expires_at: new Date('2026-05-01T00:00:00Z'),
    });
});

// ─── archiveDay ─────────────────────────────────────────────────────────

describe('archiveDay (happy path)', () => {
    it('uploads a gzipped JSONL whose SHA-256 matches the stored chain hash', async () => {
        const rows = [auditRow(), auditRow(), auditRow()];

        // No existing archive for today, no previous archive at all (genesis row).
        archiveFindOneMock
            .mockReturnValueOnce(findOneStub(null)) // existing-for-this-date check
            .mockReturnValueOnce(findOneStub(null)); // previous-archive lookup
        auditLogFindMock.mockReturnValueOnce(cursorStub(rows));
        archiveCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });
        auditLogDeleteManyMock.mockResolvedValueOnce({ deletedCount: 3 });

        const result = await svc.archiveDay('2026-01-01');

        expect(result.row_count).toBe(3);
        expect(result.skipped_reason).toBeNull();
        expect(result.sha256_hash).toMatch(/^[a-f0-9]{64}$/);

        // Upload happened with the right container + content-type.
        expect(putBlobMock).toHaveBeenCalledTimes(1);
        const uploadArgs = putBlobMock.mock.calls[0][0] as {
            container: string;
            blobKey: string;
            contentType: string;
            body: Buffer;
        };
        expect(uploadArgs.container).toBe('audit-archives');
        expect(uploadArgs.blobKey).toBe('archives/2026-01-01.jsonl.gz');
        expect(uploadArgs.contentType).toBe('application/gzip');

        // The hash recorded on the row matches the SHA-256 of what we uploaded.
        const uploaded = uploadArgs.body;
        const computed = createHash('sha256').update(uploaded).digest('hex');
        expect(result.sha256_hash).toBe(computed);

        // The bytes are valid gzipped JSONL with one row per line.
        const decoded = gunzipSync(uploaded).toString('utf8');
        const decodedLines = decoded.trim().split('\n');
        expect(decodedLines).toHaveLength(3);
        for (const line of decodedLines) {
            const parsed = JSON.parse(line);
            expect(parsed._id).toMatch(/^[a-f0-9]{24}$/);
            expect(parsed.action).toBe('user.deactivate');
        }

        // Mongo rows get deleted AFTER the row-create succeeds.
        expect(auditLogDeleteManyMock).toHaveBeenCalledTimes(1);
        const deleteFilter = auditLogDeleteManyMock.mock.calls[0][0] as { _id: { $in: Types.ObjectId[] } };
        expect(deleteFilter._id.$in).toHaveLength(3);
    });

    it('links the chain via previous_archive_id + previous_archive_hash', async () => {
        const previousArchiveId = new Types.ObjectId();
        const previousHash = 'a'.repeat(64);

        archiveFindOneMock
            .mockReturnValueOnce(findOneStub(null)) // no existing for date
            .mockReturnValueOnce(findOneStub({ _id: previousArchiveId, sha256_hash: previousHash })); // prior archive
        auditLogFindMock.mockReturnValueOnce(cursorStub([auditRow()]));
        archiveCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });
        auditLogDeleteManyMock.mockResolvedValueOnce({ deletedCount: 1 });

        await svc.archiveDay('2026-01-02');

        const created = archiveCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(created.previous_archive_id).toEqual(previousArchiveId);
        expect(created.previous_archive_hash).toBe(previousHash);
    });

    it('previous-archive lookup uses {sha256_hash: $ne null} so empty days do not sever the chain', async () => {
        archiveFindOneMock
            .mockReturnValueOnce(findOneStub(null)) // existing-check
            .mockReturnValueOnce(findOneStub(null)); // previous lookup
        auditLogFindMock.mockReturnValueOnce(cursorStub([auditRow()]));
        archiveCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });
        auditLogDeleteManyMock.mockResolvedValueOnce({ deletedCount: 1 });

        await svc.archiveDay('2026-01-05');

        // The 2nd findOne call is the previous-archive lookup. Its
        // filter must skip empty-day rows (sha256_hash: null) so the
        // chain anchors to the most recent VERIFIABLE archive even
        // when empty days exist in between.
        const previousLookupFilter = archiveFindOneMock.mock.calls[1][0] as Record<string, unknown>;
        expect(previousLookupFilter).toEqual({ sha256_hash: { $ne: null } });
    });

    it('writes an empty-day chain row WITHOUT uploading or deleting when no rows match', async () => {
        archiveFindOneMock.mockReturnValueOnce(findOneStub(null)).mockReturnValueOnce(findOneStub(null));
        auditLogFindMock.mockReturnValueOnce(cursorStub([])); // zero rows for the day
        archiveCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });

        const result = await svc.archiveDay('2026-01-03');

        expect(result.row_count).toBe(0);
        expect(result.skipped_reason).toBeNull();
        expect(putBlobMock).not.toHaveBeenCalled();
        expect(auditLogDeleteManyMock).not.toHaveBeenCalled();

        const created = archiveCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(created.row_count).toBe(0);
        expect(created.blob_container).toBeNull();
        expect(created.blob_key).toBeNull();
        expect(created.sha256_hash).toBeNull();
    });

    it('short-circuits with already_archived AND runs the self-heal deleteMany (idempotent in the normal path)', async () => {
        archiveFindOneMock.mockReturnValueOnce(findOneStub({ _id: new Types.ObjectId() }));
        // Default deleteMany mock returns deletedCount: 0 (no stranded rows).

        const result = await svc.archiveDay('2026-01-04');

        expect(result.skipped_reason).toBe('already_archived');
        expect(auditLogFindMock).not.toHaveBeenCalled();
        expect(putBlobMock).not.toHaveBeenCalled();
        expect(archiveCreateMock).not.toHaveBeenCalled();
        // Self-heal sweep fires unconditionally on the existing-archive path.
        // In the normal case it matches zero rows and is a no-op.
        expect(auditLogDeleteManyMock).toHaveBeenCalledTimes(1);
        const filter = auditLogDeleteManyMock.mock.calls[0][0] as { created_at: { $gte: Date; $lte: Date } };
        expect(filter.created_at.$gte).toBeInstanceOf(Date);
        expect(filter.created_at.$lte).toBeInstanceOf(Date);
    });

    it('self-heals stranded source rows when an earlier deleteMany failed for an already-archived date', async () => {
        archiveFindOneMock.mockReturnValueOnce(findOneStub({ _id: new Types.ObjectId() }));
        // Simulate the partial-failure recovery path: 5 rows are still
        // live in audit_logs for this date even though the archive row
        // was committed in a prior run.
        auditLogDeleteManyMock.mockResolvedValueOnce({ deletedCount: 5 });

        const result = await svc.archiveDay('2026-01-04');

        expect(result.skipped_reason).toBe('already_archived');
        expect(auditLogDeleteManyMock).toHaveBeenCalledTimes(1);
        // Date-range filter — NOT an _id filter — because the original
        // archived ID list is no longer in memory on a retry.
        const filter = auditLogDeleteManyMock.mock.calls[0][0] as { created_at: { $gte: Date; $lte: Date } };
        expect(filter.created_at).toBeDefined();
        // We don't assert the warn log here (vitest mock bookkeeping) but
        // the production code emits one on deletedCount > 0.
    });

    it('throws when Azure is unconfigured AND there are rows to archive', async () => {
        isAzureConfiguredMock.mockReturnValue(false);
        archiveFindOneMock.mockReturnValueOnce(findOneStub(null)).mockReturnValueOnce(findOneStub(null));
        auditLogFindMock.mockReturnValueOnce(cursorStub([auditRow()]));

        await expect(svc.archiveDay('2026-01-05')).rejects.toThrow(/AUDIT_ARCHIVE_STORAGE_NOT_CONFIGURED/);
        expect(archiveCreateMock).not.toHaveBeenCalled();
        expect(auditLogDeleteManyMock).not.toHaveBeenCalled();
    });
});

// ─── runArchivalSweep ──────────────────────────────────────────────────

describe('runArchivalSweep (catch-up + cap)', () => {
    it('stops scanning candidate dates once it hits an already-archived day (steady state)', async () => {
        // First candidate: not archived. Second: ARCHIVED — should stop here.
        archiveFindOneMock
            .mockReturnValueOnce(findOneStub(null)) // candidate 1 — not archived
            .mockReturnValueOnce(findOneStub({ _id: new Types.ObjectId() })); // candidate 2 — already archived

        // Inner archiveDay call for the one date that needs work.
        archiveFindOneMock
            .mockReturnValueOnce(findOneStub(null)) // archiveDay's existing-check
            .mockReturnValueOnce(findOneStub(null)); // archiveDay's previous lookup
        auditLogFindMock.mockReturnValueOnce(cursorStub([])); // empty day, fast path
        archiveCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });

        const summary = await svc.runArchivalSweep(new Date('2026-05-01T04:00:00Z'));

        // One day archived, sweep stopped after 2 candidate scans.
        expect(summary.days_archived).toBe(1);
        expect(summary.rows_archived).toBe(0);
        expect(summary.days_skipped).toBe(0);
    });

    it('caps candidate scanning at AUDIT_ARCHIVE_MAX_DAYS_PER_RUN even with a longer backlog', async () => {
        // Every candidate returns null (no existing archive) — simulating a
        // huge unbounded backlog. Sweep must still cap at the per-run limit.
        archiveFindOneMock.mockReturnValue(findOneStub(null));
        auditLogFindMock.mockReturnValue(cursorStub([])); // every day is empty
        archiveCreateMock.mockResolvedValue({ _id: new Types.ObjectId() });

        const summary = await svc.runArchivalSweep(new Date('2026-05-01T04:00:00Z'));

        // Each archived day in the backlog: empty → just creates a chain row.
        // Cap is 30; the sweep should produce at most 30 archives.
        expect(summary.days_archived).toBe(30);
    });

    it('continues past a failing day (one bad date does not abort the sweep)', async () => {
        // First candidate: not archived → first archiveDay attempt FAILS.
        // Second candidate: hits already-archived → loop stops.
        archiveFindOneMock
            .mockReturnValueOnce(findOneStub(null)) // candidate 1
            .mockReturnValueOnce(findOneStub({ _id: new Types.ObjectId() })); // candidate 2 stops scan
        // Inner archiveDay for candidate 1: throw immediately on the existing-check.
        archiveFindOneMock.mockReturnValueOnce({
            lean: () => Promise.reject(new Error('mongo blip')),
        } as never);

        const summary = await svc.runArchivalSweep(new Date('2026-05-01T04:00:00Z'));

        expect(summary.days_archived).toBe(0);
        expect(summary.days_skipped).toBe(1);
    });
});

// ─── verifyArchive ─────────────────────────────────────────────────────

describe('verifyArchive', () => {
    const setupArchive = (overrides: Record<string, unknown> = {}) => ({
        _id: new Types.ObjectId(),
        archive_date: '2026-01-01',
        blob_container: 'audit-archives',
        blob_key: 'archives/2026-01-01.jsonl.gz',
        row_count: 3,
        file_size_bytes: 100,
        sha256_hash: 'a'.repeat(64),
        ...overrides,
    });

    it('returns integrity=ok when the recomputed hash matches the stored hash', async () => {
        const bytes = Buffer.from('hello-archive-bytes');
        const hash = createHash('sha256').update(bytes).digest('hex');
        archiveFindByIdMock.mockResolvedValueOnce(setupArchive({ sha256_hash: hash }));
        downloadBlobMock.mockResolvedValueOnce(bytes);

        const result = await svc.verifyArchive(new Types.ObjectId());

        expect(result.integrity).toBe('ok');
        expect(result.expected_hash).toBe(hash);
        expect(result.computed_hash).toBe(hash);
    });

    it('returns integrity=hash_mismatch when the bytes have been tampered with', async () => {
        const tamperedBytes = Buffer.from('tampered');
        archiveFindByIdMock.mockResolvedValueOnce(setupArchive({ sha256_hash: 'b'.repeat(64) }));
        downloadBlobMock.mockResolvedValueOnce(tamperedBytes);

        const result = await svc.verifyArchive(new Types.ObjectId());

        expect(result.integrity).toBe('hash_mismatch');
        expect(result.expected_hash).toBe('b'.repeat(64));
        expect(result.computed_hash).not.toBe('b'.repeat(64));
    });

    it('returns integrity=blob_missing when the blob has been deleted (tamper signal)', async () => {
        const azureBlob = await import('../utils/azure-blob.js');
        archiveFindByIdMock.mockResolvedValueOnce(setupArchive());
        const err = new azureBlob.BlobNotFoundError('Blob not found: audit-archives/archives/2026-01-01.jsonl.gz');
        downloadBlobMock.mockRejectedValueOnce(err);

        const result = await svc.verifyArchive(new Types.ObjectId());

        expect(result.integrity).toBe('blob_missing');
        expect(result.computed_hash).toBeNull();
    });

    it('returns integrity=empty_archive for row_count=0 chain rows (no blob to verify)', async () => {
        archiveFindByIdMock.mockResolvedValueOnce(
            setupArchive({ blob_container: null, blob_key: null, sha256_hash: null, row_count: 0 })
        );

        const result = await svc.verifyArchive(new Types.ObjectId());

        expect(result.integrity).toBe('empty_archive');
        expect(downloadBlobMock).not.toHaveBeenCalled();
    });

    it('throws AUDIT_ARCHIVE_NOT_FOUND for unknown id', async () => {
        archiveFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.verifyArchive(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.AUDIT_ARCHIVE_NOT_FOUND,
        });
    });
});

// ─── listArchives ──────────────────────────────────────────────────────

describe('listArchives', () => {
    it('builds an inclusive archive_date range filter from from_date / to_date', async () => {
        archiveFindMock.mockReturnValueOnce(queryStub([]));
        archiveCountMock.mockResolvedValueOnce(0);

        await svc.listArchives({
            from_date: '2026-01-01',
            to_date: '2026-01-31',
            page: 1,
            limit: 20,
        });

        const filter = archiveFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.archive_date).toEqual({ $gte: '2026-01-01', $lte: '2026-01-31' });
    });

    it('omits the date filter entirely when both bounds absent', async () => {
        archiveFindMock.mockReturnValueOnce(queryStub([]));
        archiveCountMock.mockResolvedValueOnce(0);

        await svc.listArchives({ page: 1, limit: 20 });

        const filter = archiveFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.archive_date).toBeUndefined();
    });

    it('returns the meta envelope with computed total_pages', async () => {
        archiveFindMock.mockReturnValueOnce(queryStub([]));
        archiveCountMock.mockResolvedValueOnce(47);

        const result = await svc.listArchives({ page: 1, limit: 20 });

        expect(result.meta).toEqual({ page: 1, limit: 20, total: 47, total_pages: 3 });
    });
});

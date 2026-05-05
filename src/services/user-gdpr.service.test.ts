import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for the GDPR DSAR + erasure service (BACKEND_AUDIT.md P1-8).
 *
 * Contract:
 *   1. exportUserData throws RESOURCE_NOT_FOUND for an unknown user id.
 *   2. exportUserData strips credential fields (password_hash,
 *      mfa_secret_encrypted, mfa_backup_codes_hashed) from the user
 *      block — these aren't the user's data in the GDPR sense.
 *   3. eraseUserData replaces email with a synthetic per-user value
 *      (uniqueness preserved across multiple erasures).
 *   4. eraseUserData revokes every active session + deletes reset
 *      tokens + writes the audit row.
 *   5. eraseUserData is idempotent — re-running on an already-erased
 *      user produces the same anon shape (synthetic values are
 *      derived from `_id`, not random).
 */

const {
    userFindByIdMock,
    userFindByIdLeanMock,
    userUpdateOneMock,
    refreshUpdateManyMock,
    refreshCountMock,
    resetTokenDeleteManyMock,
    auditLogFindMock,
    countingFindMock,
    recordAuditMock,
    deleteBlobMock,
    isAzureConfiguredMock,
} = vi.hoisted(() => ({
    userFindByIdMock: vi.fn(),
    userFindByIdLeanMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    refreshUpdateManyMock: vi.fn(),
    refreshCountMock: vi.fn(),
    resetTokenDeleteManyMock: vi.fn(),
    auditLogFindMock: vi.fn(),
    countingFindMock: vi.fn(),
    recordAuditMock: vi.fn(),
    deleteBlobMock: vi.fn(),
    isAzureConfiguredMock: vi.fn(),
}));

// Helper: a `find().lean()` chain that resolves to an empty array.
const emptyFindLeanReturn = () => ({ lean: () => Promise.resolve([]) });

vi.mock('../models/user.model.js', () => ({
    User: {
        findById: userFindByIdMock,
        updateOne: userUpdateOneMock,
    },
}));

vi.mock('../models/refresh-token.model.js', () => ({
    RefreshToken: {
        countDocuments: refreshCountMock,
        updateMany: refreshUpdateManyMock,
    },
}));

vi.mock('../models/password-reset-token.model.js', () => ({
    PasswordResetToken: { deleteMany: resetTokenDeleteManyMock },
}));

vi.mock('../models/attendance-record.model.js', () => ({ AttendanceRecord: { find: countingFindMock } }));
vi.mock('../models/attendance-correction-request.model.js', () => ({
    AttendanceCorrectionRequest: { find: countingFindMock },
}));
vi.mock('../models/leave-request.model.js', () => ({ LeaveRequest: { find: countingFindMock } }));
vi.mock('../models/leave-balance.model.js', () => ({ LeaveBalance: { find: countingFindMock } }));
vi.mock('../models/comp-off-ledger.model.js', () => ({ CompOffLedger: { find: countingFindMock } }));
vi.mock('../models/notification.model.js', () => ({ Notification: { find: countingFindMock } }));
vi.mock('../models/task-comment.model.js', () => ({ TaskComment: { find: countingFindMock } }));
vi.mock('../models/task-activity.model.js', () => ({ TaskActivity: { find: countingFindMock } }));
vi.mock('../models/timesheet-entry.model.js', () => ({ TimesheetEntry: { find: countingFindMock } }));
vi.mock('../models/audit-log.model.js', () => ({ AuditLog: { find: auditLogFindMock } }));
vi.mock('../models/report-preset.model.js', () => ({ ReportPreset: { find: countingFindMock } }));
vi.mock('../models/report-subscription.model.js', () => ({ ReportSubscription: { find: countingFindMock } }));
vi.mock('../models/report-export.model.js', () => ({ ReportExport: { find: countingFindMock } }));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
}));

vi.mock('../utils/azure-blob.js', () => ({
    deleteBlob: deleteBlobMock,
    isAzureConfigured: isAzureConfiguredMock,
}));

vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { exportUserData, eraseUserData } = await import('./user-gdpr.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS } from '../constants/audit.js';

beforeEach(() => {
    userFindByIdMock.mockReset();
    userFindByIdLeanMock.mockReset();
    userUpdateOneMock.mockReset();
    refreshUpdateManyMock.mockReset();
    refreshCountMock.mockReset();
    resetTokenDeleteManyMock.mockReset();
    auditLogFindMock.mockReset();
    countingFindMock.mockReset();
    recordAuditMock.mockReset();

    refreshCountMock.mockResolvedValue(0);
    refreshUpdateManyMock.mockResolvedValue({ modifiedCount: 0 });
    resetTokenDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    auditLogFindMock.mockReturnValue(emptyFindLeanReturn());
    countingFindMock.mockReturnValue(emptyFindLeanReturn());
    userUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
    recordAuditMock.mockResolvedValue(undefined);
    deleteBlobMock.mockReset();
    isAzureConfiguredMock.mockReset();
    isAzureConfiguredMock.mockReturnValue(true);
    deleteBlobMock.mockResolvedValue(undefined);
});

const sampleUser = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
    email: 'jane@example.com',
    full_name: 'Jane Doe',
    phone: '+1234',
    password_hash: '$2b$12$abcdefg',
    mfa_enabled: true,
    mfa_secret_encrypted: 'ENCRYPTED_SECRET',
    mfa_backup_codes_hashed: ['hash1', 'hash2'],
    role: 'employee',
    status: 'active',
    ...overrides,
});

describe('exportUserData', () => {
    it('throws RESOURCE_NOT_FOUND for an unknown user', async () => {
        userFindByIdMock.mockReturnValueOnce({ lean: () => Promise.resolve(null) });

        await expect(exportUserData(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
        });
    });

    it('strips credential fields from the exported user block', async () => {
        const user = sampleUser();
        userFindByIdMock.mockReturnValueOnce({ lean: () => Promise.resolve(user) });

        const dump = await exportUserData(user._id);

        expect(dump.user).not.toBeNull();
        expect(dump.user!.email).toBe('jane@example.com');
        expect(dump.user!.full_name).toBe('Jane Doe');
        // Credentials must never appear in the export.
        expect(dump.user!.password_hash).toBeUndefined();
        expect(dump.user!.mfa_secret_encrypted).toBeUndefined();
        expect(dump.user!.mfa_backup_codes_hashed).toBeUndefined();
    });

    it('returns the canonical envelope with every collection key', async () => {
        const user = sampleUser();
        userFindByIdMock.mockReturnValueOnce({ lean: () => Promise.resolve(user) });

        const dump = await exportUserData(user._id);

        // Pin the keys so a future contributor adding a new PII collection is
        // forced to update the envelope explicitly.
        expect(Object.keys(dump).sort()).toEqual(
            [
                'attendance_correction_requests',
                'attendance_records',
                'audit_log_actor',
                'audit_log_target',
                'comp_off_ledger',
                'exported_at',
                'leave_balances',
                'leave_requests',
                'notifications',
                'refresh_tokens_active_count',
                'report_exports',
                'report_presets',
                'report_subscriptions',
                'task_activities',
                'task_comments',
                'timesheet_entries',
                'user',
            ].sort()
        );
    });
});

describe('eraseUserData', () => {
    const auditCtx = {
        actor_id: new Types.ObjectId(),
        actor_role: 'admin' as const,
        ip: '127.0.0.1',
        user_agent: 'curl',
        request_id: 'req-1',
    };

    it('throws RESOURCE_NOT_FOUND for an unknown user', async () => {
        userFindByIdMock.mockResolvedValueOnce(null);

        await expect(eraseUserData(new Types.ObjectId(), auditCtx)).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
        });
    });

    it('replaces PII fields with synthetic, deterministic-from-_id values', async () => {
        const user = sampleUser();
        userFindByIdMock.mockResolvedValueOnce(user);

        await eraseUserData(user._id, auditCtx);

        const updateArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        // Synthetic suffix derived from last 8 chars of _id.
        const suffix = user._id.toString().slice(-8);
        expect(updateArg.$set.email).toBe(`deleted-${suffix}@anonymised.invalid`);
        expect(updateArg.$set.full_name).toBe(`Deleted user ${suffix}`);
        expect(updateArg.$set.phone).toBeNull();
        expect(updateArg.$set.profile_photo_blob_key).toBeNull();
        expect(updateArg.$set.password_hash).toBe('erased');
        expect(updateArg.$set.mfa_enabled).toBe(false);
        expect(updateArg.$set.status).toBe('deactivated');
    });

    it('revokes every active refresh token and deletes reset tokens', async () => {
        const user = sampleUser();
        userFindByIdMock.mockResolvedValueOnce(user);
        refreshUpdateManyMock.mockResolvedValueOnce({ modifiedCount: 3 });
        resetTokenDeleteManyMock.mockResolvedValueOnce({ deletedCount: 2 });

        const result = await eraseUserData(user._id, auditCtx);

        expect(refreshUpdateManyMock).toHaveBeenCalledWith(
            { user_id: user._id, revoked_at: null },
            { $set: { revoked_at: expect.any(Date) } }
        );
        expect(resetTokenDeleteManyMock).toHaveBeenCalledWith({ user_id: user._id });
        expect(result.sessions_revoked).toBe(3);
        expect(result.reset_tokens_deleted).toBe(2);
    });

    it('emits a USER_DATA_ERASE audit row with the before/after snapshot', async () => {
        const user = sampleUser();
        userFindByIdMock.mockResolvedValueOnce(user);

        await eraseUserData(user._id, auditCtx);

        expect(recordAuditMock).toHaveBeenCalledWith(
            auditCtx,
            expect.objectContaining({
                action: AUDIT_ACTIONS.USER_DATA_ERASE,
                target: expect.objectContaining({ id: user._id }),
                before: expect.objectContaining({
                    email: 'jane@example.com',
                    full_name: 'Jane Doe',
                    status: 'active',
                }),
                after: expect.objectContaining({
                    full_name: expect.stringMatching(/^Deleted user/),
                    email: expect.stringMatching(/@anonymised\.invalid$/),
                }),
            })
        );
    });

    // ─── R1: profile-photo blob delete ─────────────────────────────────

    it('deletes the profile-photo blob from Azure when one exists', async () => {
        const user = sampleUser({ profile_photo_blob_key: 'users/abc/photo.jpg' });
        userFindByIdMock.mockResolvedValueOnce(user);

        const result = await eraseUserData(user._id, auditCtx);

        expect(deleteBlobMock).toHaveBeenCalledWith(expect.any(String), 'users/abc/photo.jpg');
        expect(result.profile_photo_blob_deleted).toBe(true);
    });

    it('skips the blob delete when the user has no photo', async () => {
        const user = sampleUser({ profile_photo_blob_key: null });
        userFindByIdMock.mockResolvedValueOnce(user);

        const result = await eraseUserData(user._id, auditCtx);

        expect(deleteBlobMock).not.toHaveBeenCalled();
        expect(result.profile_photo_blob_deleted).toBe(false);
    });

    it('skips the blob delete with a warn when Azure is not configured', async () => {
        isAzureConfiguredMock.mockReturnValue(false);
        const user = sampleUser({ profile_photo_blob_key: 'users/abc/photo.jpg' });
        userFindByIdMock.mockResolvedValueOnce(user);

        const result = await eraseUserData(user._id, auditCtx);

        expect(deleteBlobMock).not.toHaveBeenCalled();
        expect(result.profile_photo_blob_deleted).toBe(false);
    });

    it('continues the erasure even when blob delete throws (best-effort)', async () => {
        // Blob delete failure must not abort the user-doc anonymisation —
        // the user is already anonymised at this point and a re-run is
        // idempotent for the doc + retries the blob.
        const user = sampleUser({ profile_photo_blob_key: 'users/abc/photo.jpg' });
        userFindByIdMock.mockResolvedValueOnce(user);
        deleteBlobMock.mockRejectedValueOnce(new Error('blob 403'));

        const result = await eraseUserData(user._id, auditCtx);

        // Erasure result still returned — operation succeeds despite the blob failure.
        expect(result.user_id).toBe(user._id.toString());
        expect(result.profile_photo_blob_deleted).toBe(false);
        // User doc was still anonymised.
        expect(userUpdateOneMock).toHaveBeenCalled();
        // Audit row still emitted.
        expect(recordAuditMock).toHaveBeenCalled();
    });

    it('idempotent: re-running on an already-erased user produces the same synthetic email', async () => {
        // Round 1.
        const user1 = sampleUser();
        userFindByIdMock.mockResolvedValueOnce(user1);
        await eraseUserData(user1._id, auditCtx);
        const round1 = (userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> }).$set.email;

        userUpdateOneMock.mockClear();

        // Round 2 — same _id, the user is now anonymised but still exists.
        const user2 = sampleUser({ email: round1, full_name: `Deleted user ${user1._id.toString().slice(-8)}` });
        userFindByIdMock.mockResolvedValueOnce(user2);
        await eraseUserData(user1._id, auditCtx);
        const round2 = (userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> }).$set.email;

        expect(round2).toBe(round1);
    });
});

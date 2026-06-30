import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `profile-photo.service` (Step 22).
 *
 * Coverage focus:
 *   1. `mintUploadUrl` — image-only MIME enforcement, 5 MiB hard cap,
 *      blob_key namespaced under caller (`users/{caller.id}/...`),
 *      503 when Azure unconfigured.
 *   2. `finalizeProfilePhoto` — cross-user blob_key rejection (the same
 *      ship-blocker that bit Step 21), wrong-container rejection, blob
 *      missing, claimed-vs-actual size mismatch, atomic replace
 *      (previous blob is best-effort deleted only after pointer swap),
 *      audit recorded with previous + new blob_key.
 *   3. `clearProfilePhoto` — idempotent when no photo set, deletes blob
 *      when present, audit captures previous blob_key.
 *   4. `signProfilePhotoUrl` — null when no key, null when Azure
 *      unconfigured, string when both conditions met.
 */

const {
    userFindByIdMock,
    recordAuditMock,
    getOrInitSettingsMock,
    isAzureConfiguredMock,
    mintUploadSasMock,
    mintDownloadSasMock,
    headBlobMock,
    deleteBlobMock,
} = vi.hoisted(() => ({
    userFindByIdMock: vi.fn(),
    recordAuditMock: vi.fn(),
    getOrInitSettingsMock: vi.fn(),
    isAzureConfiguredMock: vi.fn(),
    mintUploadSasMock: vi.fn(),
    mintDownloadSasMock: vi.fn(),
    headBlobMock: vi.fn(),
    deleteBlobMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: getOrInitSettingsMock,
}));

vi.mock('../utils/azure-blob.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/azure-blob.js')>();
    return {
        ...actual,
        isAzureConfigured: isAzureConfiguredMock,
        mintUploadSas: mintUploadSasMock,
        mintDownloadSas: mintDownloadSasMock,
        headBlob: headBlobMock,
        deleteBlob: deleteBlobMock,
    };
});

const svc = await import('./profile-photo.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
// Assert against the CONFIGURED container (env may override the default),
// so the test verifies the real contract instead of a hardcoded literal.
import { AZURE_BLOB_PROFILE_PHOTOS_CONTAINER } from '../config/server.config.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const makeCaller = (id?: Types.ObjectId) => ({ id: id ?? new Types.ObjectId(), audit: undefined });

const makeUser = (overrides: Record<string, unknown> = {}) => {
    const u = {
        _id: new Types.ObjectId(),
        profile_photo_blob_key: null as string | null,
        save: vi.fn(),
        ...overrides,
    };
    u.save.mockImplementation(async () => u);
    return u;
};

const defaultSettings = (overrides: Record<string, unknown> = {}) => ({
    uploads: {
        max_file_size_mb: 25,
        allowed_mime_types: ['image/png'],
        sas_token_ttl_minutes: 15,
        ...overrides,
    },
});

beforeEach(() => {
    vi.resetAllMocks();
    isAzureConfiguredMock.mockReturnValue(true);
    getOrInitSettingsMock.mockResolvedValue(defaultSettings());
    mintUploadSasMock.mockReturnValue({
        url: 'https://example.blob.core.windows.net/profile-photos/key?sas',
        expires_at: new Date(Date.now() + 15 * 60_000),
    });
    mintDownloadSasMock.mockReturnValue({
        url: 'https://example.blob.core.windows.net/profile-photos/key?sas',
        expires_at: new Date(Date.now() + 15 * 60_000),
    });
});

// ─── mintUploadUrl ───────────────────────────────────────────────────────

describe('mintUploadUrl', () => {
    it('returns 503 STORAGE_NOT_CONFIGURED when Azure env is missing', async () => {
        isAzureConfiguredMock.mockReturnValue(false);
        await expect(
            svc.mintUploadUrl({ file_name: 'a.png', file_size: 1024, mime_type: 'image/png' }, makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.STORAGE_NOT_CONFIGURED, statusCode: 503 });
    });

    it('rejects oversize uploads with FILE_TOO_LARGE (5 MiB hard cap)', async () => {
        await expect(
            svc.mintUploadUrl(
                { file_name: 'big.png', file_size: 10 * 1024 * 1024, mime_type: 'image/png' },
                makeCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.FILE_TOO_LARGE });
        expect(mintUploadSasMock).not.toHaveBeenCalled();
    });

    it('rejects non-image MIME types with FILE_TYPE_NOT_ALLOWED', async () => {
        await expect(
            svc.mintUploadUrl({ file_name: 'doc.pdf', file_size: 1024, mime_type: 'application/pdf' }, makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED });
    });

    it('accepts uppercase MIME types (RFC 2045 case-insensitivity)', async () => {
        // Curl + a few stricter HTTP clients send `image/PNG` rather than
        // the lowercase variant browsers use. Both must be accepted.
        const caller = makeCaller();
        await expect(
            svc.mintUploadUrl({ file_name: 'a.png', file_size: 1024, mime_type: 'IMAGE/PNG' }, caller)
        ).resolves.toBeDefined();
        expect(mintUploadSasMock).toHaveBeenCalled();
    });

    it('rejects scriptable image types (svg) even though they are images', async () => {
        // SVG is excluded because it can carry inline JS. This is a fixed
        // policy not driven by `system_settings` — admins cannot widen it.
        await expect(
            svc.mintUploadUrl({ file_name: 'logo.svg', file_size: 1024, mime_type: 'image/svg+xml' }, makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED });
    });

    it('mints a SAS, namespaces blob_key under users/{caller.id}/, pins content-type', async () => {
        const caller = makeCaller();
        const result = await svc.mintUploadUrl(
            { file_name: 'My Avatar.png', file_size: 1024, mime_type: 'image/png' },
            caller
        );

        expect(result.upload_url).toMatch(/^https:\/\//);
        expect(result.blob_key.startsWith(`users/${caller.id.toString()}/`)).toBe(true);
        expect(result.blob_key).toMatch(/My_Avatar\.png$/);
        expect(result.required_headers['Content-Type']).toBe('image/png');
        expect(mintUploadSasMock).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'image/png' }));
    });
});

// ─── finalizeProfilePhoto ────────────────────────────────────────────────

describe('finalizeProfilePhoto', () => {
    const validBody = (uploaderId: Types.ObjectId) => ({
        blob_container: AZURE_BLOB_PROFILE_PHOTOS_CONTAINER,
        blob_key: `users/${uploaderId.toString()}/01ULID-avatar.png`,
        file_name: 'avatar.png',
        file_size: 1024,
        mime_type: 'image/png',
    });

    it('rejects a blob_key uploaded under a different user (cross-user theft)', async () => {
        const userA = new Types.ObjectId();
        const userB = makeCaller(); // attacker
        await expect(
            svc.finalizeProfilePhoto(
                {
                    blob_container: AZURE_BLOB_PROFILE_PHOTOS_CONTAINER,
                    blob_key: `users/${userA.toString()}/01ULID-avatar.png`,
                    file_name: 'avatar.png',
                    file_size: 1024,
                    mime_type: 'image/png',
                },
                userB
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_BLOB_KEY_MISMATCH });
        expect(headBlobMock).not.toHaveBeenCalled();
        expect(userFindByIdMock).not.toHaveBeenCalled();
    });

    it('rejects a key in the wrong container even with matching user prefix', async () => {
        const caller = makeCaller();
        await expect(
            svc.finalizeProfilePhoto(
                {
                    blob_container: 'task-attachments',
                    blob_key: `users/${caller.id.toString()}/01ULID-avatar.png`,
                    file_name: 'avatar.png',
                    file_size: 1024,
                    mime_type: 'image/png',
                },
                caller
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_BLOB_KEY_MISMATCH });
    });

    it('rejects when the blob does not exist in storage', async () => {
        const caller = makeCaller();
        headBlobMock.mockResolvedValueOnce({ exists: false });
        await expect(svc.finalizeProfilePhoto(validBody(caller.id), caller)).rejects.toMatchObject({
            code: ERROR_CODES.ATTACHMENT_BLOB_MISSING,
        });
    });

    it('rejects when uploaded blob size differs from claimed size', async () => {
        const caller = makeCaller();
        headBlobMock.mockResolvedValueOnce({ exists: true, size: 9999, contentType: 'image/png' });
        await expect(svc.finalizeProfilePhoto(validBody(caller.id), caller)).rejects.toMatchObject({
            code: ERROR_CODES.ATTACHMENT_SIZE_MISMATCH,
        });
    });

    it('persists the new blob_key on the user and best-effort deletes the previous blob', async () => {
        const caller = makeCaller();
        const previousKey = `users/${caller.id.toString()}/00OLD-old.png`;
        const user = makeUser({ _id: caller.id, profile_photo_blob_key: previousKey });
        userFindByIdMock.mockResolvedValueOnce(user);
        headBlobMock.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/png' });

        const newBody = validBody(caller.id);
        const result = await svc.finalizeProfilePhoto(newBody, caller);

        expect(user.profile_photo_blob_key).toBe(newBody.blob_key);
        expect(user.save).toHaveBeenCalledTimes(1);
        // Previous blob deleted AFTER the pointer swap.
        expect(deleteBlobMock).toHaveBeenCalledWith(AZURE_BLOB_PROFILE_PHOTOS_CONTAINER, previousKey);
        expect((result as { profile_photo_url: string | null }).profile_photo_url).toMatch(/^https:\/\//);
    });

    it('does not call deleteBlob when the user had no previous photo', async () => {
        const caller = makeCaller();
        const user = makeUser({ _id: caller.id, profile_photo_blob_key: null });
        userFindByIdMock.mockResolvedValueOnce(user);
        headBlobMock.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/png' });

        await svc.finalizeProfilePhoto(validBody(caller.id), caller);
        expect(deleteBlobMock).not.toHaveBeenCalled();
    });

    it('records an audit row with previous + new blob_key when caller carries an audit context', async () => {
        const caller = {
            id: new Types.ObjectId(),
            audit: {
                actor_id: new Types.ObjectId(),
                actor_role: 'admin' as const,
                ip: '10.0.0.1',
                user_agent: 'unit-test',
            },
        };
        const previousKey = `users/${caller.id.toString()}/00OLD-old.png`;
        const user = makeUser({ _id: caller.id, profile_photo_blob_key: previousKey });
        userFindByIdMock.mockResolvedValueOnce(user);
        headBlobMock.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/png' });

        const newBody = validBody(caller.id);
        await svc.finalizeProfilePhoto(newBody, caller);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [auditCtx, payload] = recordAuditMock.mock.calls[0];
        expect(auditCtx).toBe(caller.audit);
        expect(payload).toEqual(
            expect.objectContaining({
                action: 'user.profile_photo_set',
                metadata: expect.objectContaining({
                    blob_key: newBody.blob_key,
                    previous_blob_key: previousKey,
                    size_bytes: 1024,
                    mime_type: 'image/png',
                }),
            })
        );
    });
});

// ─── clearProfilePhoto ───────────────────────────────────────────────────

describe('clearProfilePhoto', () => {
    it('is a no-op (cleared:true) when the user has no photo set', async () => {
        const caller = makeCaller();
        const user = makeUser({ _id: caller.id, profile_photo_blob_key: null });
        userFindByIdMock.mockResolvedValueOnce(user);

        const result = await svc.clearProfilePhoto(caller);
        expect(result).toEqual({ cleared: true, previous_blob_key: null });
        expect(user.save).not.toHaveBeenCalled();
        expect(deleteBlobMock).not.toHaveBeenCalled();
        expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it('clears the pointer + deletes the blob when a photo exists', async () => {
        const caller = makeCaller();
        const previousKey = `users/${caller.id.toString()}/01-old.png`;
        const user = makeUser({ _id: caller.id, profile_photo_blob_key: previousKey });
        userFindByIdMock.mockResolvedValueOnce(user);

        const result = await svc.clearProfilePhoto(caller);
        expect(result).toEqual({ cleared: true, previous_blob_key: previousKey });
        expect(user.profile_photo_blob_key).toBeNull();
        expect(user.save).toHaveBeenCalledTimes(1);
        expect(deleteBlobMock).toHaveBeenCalledWith(AZURE_BLOB_PROFILE_PHOTOS_CONTAINER, previousKey);
    });

    it('skips blob delete (still clears the pointer) when Azure is unconfigured', async () => {
        isAzureConfiguredMock.mockReturnValue(false);
        const caller = makeCaller();
        const user = makeUser({
            _id: caller.id,
            profile_photo_blob_key: `users/${caller.id.toString()}/01-old.png`,
        });
        userFindByIdMock.mockResolvedValueOnce(user);

        await svc.clearProfilePhoto(caller);
        expect(user.profile_photo_blob_key).toBeNull();
        expect(deleteBlobMock).not.toHaveBeenCalled();
    });
});

// ─── signProfilePhotoUrl ─────────────────────────────────────────────────

describe('signProfilePhotoUrl', () => {
    it('returns null when blob_key is null', () => {
        expect(svc.signProfilePhotoUrl(null, 15)).toBeNull();
        expect(mintDownloadSasMock).not.toHaveBeenCalled();
    });

    it('returns null when Azure is unconfigured (defence — must not throw from serialiser)', () => {
        isAzureConfiguredMock.mockReturnValue(false);
        expect(svc.signProfilePhotoUrl('users/abc/pic.png', 15)).toBeNull();
        expect(mintDownloadSasMock).not.toHaveBeenCalled();
    });

    it('returns a SAS URL when both configured + blob_key present', () => {
        const url = svc.signProfilePhotoUrl('users/abc/pic.png', 15);
        expect(url).toMatch(/^https:\/\//);
        expect(mintDownloadSasMock).toHaveBeenCalledWith(
            expect.objectContaining({ container: AZURE_BLOB_PROFILE_PHOTOS_CONTAINER, blobKey: 'users/abc/pic.png' })
        );
    });

    it('returns null and logs when underlying SAS minter throws (no serialiser failure)', () => {
        mintDownloadSasMock.mockImplementationOnce(() => {
            throw new Error('boom');
        });
        expect(svc.signProfilePhotoUrl('users/abc/pic.png', 15)).toBeNull();
    });
});

import { Types } from 'mongoose';
import { ulid } from 'ulid';

import { User, type UserDocument } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { PROFILE_PHOTO_ALLOWED_MIME_TYPES, PROFILE_PHOTO_MAX_BYTES } from '../constants/profile-photo.js';
import {
    ATTACHMENT_SAS_TTL_DEFAULT_MINUTES,
    ATTACHMENT_SAS_TTL_MAX_MINUTES,
    ATTACHMENT_SAS_TTL_MIN_MINUTES,
} from '../constants/attachment.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { getOrInitSettings } from './settings.service.js';
import {
    AzureNotConfiguredError,
    deleteBlob,
    headBlob,
    isAzureConfigured,
    mintDownloadSas,
    mintUploadSas,
} from '../utils/azure-blob.js';
import { AZURE_BLOB_PROFILE_PHOTOS_CONTAINER } from '../config/server.config.js';
import logger from '../utils/logger.js';
import type { ProfilePhotoFinalizeBody, ProfilePhotoUploadUrlBody } from '../validators/profile-photo.validator.js';

/**
 * Profile-photo service — Step 22.
 *
 * Why a separate service from `task-attachment.service`:
 *  - The data model is different: there is no `task_attachments`-style
 *    row. Each user owns at most one current photo, identified by
 *    `users.profile_photo_blob_key`. Re-uploading replaces the pointer
 *    in place + best-effort deletes the old blob.
 *  - The policy is fixed in code (not driven by `system_settings.uploads`):
 *    image-only allowlist, 5 MiB hard cap. An admin can't widen it
 *    accidentally and admit a scriptable type like `image/svg+xml`.
 *  - The route surface is `/users/me/*` only — there is no admin
 *    override; the caller is always the subject. That removes the
 *    cross-user blob_key theft concern modulo path-namespacing.
 *
 * Mirrors Step 21's hardening:
 *  - blob_key namespaced as `users/{user_id}/{ulid}-{safe_name}`.
 *  - Finalize requires the path's user_id segment to equal `caller.id`.
 *  - Upload SAS is `c` (create-only); download SAS sets
 *    `Content-Disposition: attachment; filename=...` (defence-in-depth
 *    even though our allowlist excludes scriptable types).
 *  - HEAD-check + claimed-vs-actual size cross-check before persist.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface ProfilePhotoCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

export interface MintProfilePhotoUploadUrlResult {
    upload_url: string;
    blob_container: string;
    blob_key: string;
    expires_at: Date;
    method: 'PUT';
    required_headers: { 'x-ms-blob-type': 'BlockBlob'; 'Content-Type': string };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const assertAzureConfigured = (): void => {
    if (!isAzureConfigured()) {
        throw new AppError({
            statusCode: 503,
            code: ERROR_CODES.STORAGE_NOT_CONFIGURED,
            message: 'Profile-photo storage is not configured on this environment',
        });
    }
};

const mapAzureNotConfigured = (err: unknown): never => {
    if (err instanceof AzureNotConfiguredError) {
        throw new AppError({
            statusCode: 503,
            code: ERROR_CODES.STORAGE_NOT_CONFIGURED,
            message: err.message,
        });
    }
    throw err;
};

const sanitiseFileName = (name: string): string => {
    const trimmed = name.trim();
    const cleaned = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_');
    const noEdges = cleaned.replace(/^[._-]+/, '').replace(/[._-]+$/, '');
    return noEdges.length > 0 ? noEdges : 'photo';
};

export const buildBlobKey = (userId: Types.ObjectId, fileName: string): string => {
    const safe = sanitiseFileName(fileName);
    return `users/${userId.toString()}/${ulid()}-${safe}`;
};

const expectedBlobKeyPrefix = (userId: Types.ObjectId): string => `users/${userId.toString()}/`;

const assertSizeAllowed = (size: number): void => {
    if (size > PROFILE_PHOTO_MAX_BYTES) {
        throw AppError.unprocessable(
            `Profile photo exceeds the maximum size of ${PROFILE_PHOTO_MAX_BYTES} bytes`,
            ERROR_CODES.FILE_TOO_LARGE,
            { max_bytes: PROFILE_PHOTO_MAX_BYTES, received_bytes: size }
        );
    }
};

const assertMimeAllowed = (mime: string): void => {
    // RFC 2045 §5.1 makes MIME types case-insensitive. Browsers happen to
    // send lowercase, but a stricter client (or a curl-driven test) might
    // post `image/PNG` — accept either by normalising before the lookup.
    // The allowlist itself is stored lowercase in `constants/profile-photo.ts`.
    if (!PROFILE_PHOTO_ALLOWED_MIME_TYPES.has(mime.toLowerCase())) {
        throw AppError.unprocessable(
            `MIME type "${mime}" is not allowed for profile photos`,
            ERROR_CODES.FILE_TYPE_NOT_ALLOWED,
            { mime_type: mime, allowed: Array.from(PROFILE_PHOTO_ALLOWED_MIME_TYPES) }
        );
    }
};

const loadUser = async (userId: Types.ObjectId): Promise<UserDocument> => {
    const user = await User.findById(userId);
    if (!user) throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    return user;
};

interface SasTtl {
    uploadMinutes: number;
    downloadMinutes: number;
}

const loadSasTtl = async (): Promise<SasTtl> => {
    const settings = await getOrInitSettings();
    const raw = settings.uploads.sas_token_ttl_minutes;
    const clamped = Math.min(
        ATTACHMENT_SAS_TTL_MAX_MINUTES,
        Math.max(ATTACHMENT_SAS_TTL_MIN_MINUTES, Number.isFinite(raw) ? raw : ATTACHMENT_SAS_TTL_DEFAULT_MINUTES)
    );
    return { uploadMinutes: clamped, downloadMinutes: clamped };
};

// ─── POST /users/me/profile-photo-upload-url ─────────────────────────────

export const mintUploadUrl = async (
    input: ProfilePhotoUploadUrlBody,
    caller: ProfilePhotoCaller
): Promise<MintProfilePhotoUploadUrlResult> => {
    assertAzureConfigured();

    assertSizeAllowed(input.file_size);
    assertMimeAllowed(input.mime_type);

    const ttl = await loadSasTtl();
    const container = AZURE_BLOB_PROFILE_PHOTOS_CONTAINER;
    const blobKey = buildBlobKey(caller.id, input.file_name);

    let minted: { url: string; expires_at: Date };
    try {
        minted = mintUploadSas({
            container,
            blobKey,
            ttlMinutes: ttl.uploadMinutes,
            contentType: input.mime_type,
        });
    } catch (err) {
        throw mapAzureNotConfigured(err);
    }

    return {
        upload_url: minted.url,
        blob_container: container,
        blob_key: blobKey,
        expires_at: minted.expires_at,
        method: 'PUT',
        required_headers: {
            'x-ms-blob-type': 'BlockBlob',
            'Content-Type': input.mime_type,
        },
    };
};

// ─── POST /users/me/profile-photo (finalize) ─────────────────────────────
//
// Known limitations (accepted; tracked for a Phase-3 hardening pass):
//
//  - Orphan blob on transient mongo failure. The pointer is swapped via
//    `user.save()` AFTER the new blob has been HEAD-checked. If `save()`
//    throws, the blob exists in storage with no DB pointer — wasted
//    storage but no user impact. Same shape as `task-attachment.service`.
//    A reconciliation cron (Phase 3) is the right fix; we don't compensate
//    inline because a transient mongo failure that loses our save is also
//    likely to lose a follow-up `deleteBlob`'s side effects.
//
//  - Concurrent finalize + DELETE for the same user. find/save isn't
//    atomic in Mongoose, so two parallel calls can clobber each other's
//    pointer state. A user racing themselves is unusual and self-inflicted;
//    `findOneAndUpdate` with a guard would close it cleanly when we touch
//    this surface again.

export const finalizeProfilePhoto = async (
    input: ProfilePhotoFinalizeBody,
    caller: ProfilePhotoCaller
): Promise<Record<string, unknown>> => {
    assertAzureConfigured();

    assertSizeAllowed(input.file_size);
    assertMimeAllowed(input.mime_type);

    // Re-validate the blob_key prefix: must be under this caller's
    // namespace AND in the configured profile-photo container. Either
    // mismatch is treated identically — the FE never legitimately
    // produces a key outside its own scope.
    const expectedPrefix = expectedBlobKeyPrefix(caller.id);
    if (!input.blob_key.startsWith(expectedPrefix) || input.blob_container !== AZURE_BLOB_PROFILE_PHOTOS_CONTAINER) {
        throw AppError.unprocessable(
            'blob_key does not belong to this user / container',
            ERROR_CODES.ATTACHMENT_BLOB_KEY_MISMATCH,
            { expected_prefix: expectedPrefix, expected_container: AZURE_BLOB_PROFILE_PHOTOS_CONTAINER }
        );
    }

    let head;
    try {
        head = await headBlob(input.blob_container, input.blob_key);
    } catch (err) {
        throw mapAzureNotConfigured(err);
    }
    if (!head.exists) {
        throw AppError.unprocessable(
            'No uploaded blob was found for this key — upload it before finalizing',
            ERROR_CODES.ATTACHMENT_BLOB_MISSING,
            { blob_key: input.blob_key }
        );
    }
    if (typeof head.size === 'number' && head.size !== input.file_size) {
        throw AppError.unprocessable(
            'Uploaded file size does not match the value supplied to finalize',
            ERROR_CODES.ATTACHMENT_SIZE_MISMATCH,
            { claimed_bytes: input.file_size, actual_bytes: head.size }
        );
    }
    if (typeof head.size === 'number') assertSizeAllowed(head.size);

    const user = await loadUser(caller.id);
    const previousBlobKey = user.profile_photo_blob_key;

    user.profile_photo_blob_key = input.blob_key;
    await user.save();

    // Best-effort delete of the previous blob. Done after the pointer
    // swap so a transient Azure failure can't leave the user pointing at
    // a deleted blob. The new blob is already verified.
    if (previousBlobKey && previousBlobKey !== input.blob_key && isAzureConfigured()) {
        await deleteBlob(AZURE_BLOB_PROFILE_PHOTOS_CONTAINER, previousBlobKey);
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.USER_PROFILE_PHOTO_SET,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: user._id },
            metadata: {
                blob_key: input.blob_key,
                previous_blob_key: previousBlobKey,
                size_bytes: typeof head.size === 'number' ? head.size : input.file_size,
                mime_type: input.mime_type,
            },
        });
    }

    return {
        id: user._id.toString(),
        profile_photo_blob_key: user.profile_photo_blob_key,
        profile_photo_url: signProfilePhotoUrl(user.profile_photo_blob_key, ttlOrDefault(await loadSasTtl())),
    };
};

// ─── DELETE /users/me/profile-photo ──────────────────────────────────────
//
// Idempotent: clearing a user with no current photo is a no-op success.
// The blob delete is best-effort.

export const clearProfilePhoto = async (
    caller: ProfilePhotoCaller
): Promise<{ cleared: true; previous_blob_key: string | null }> => {
    const user = await loadUser(caller.id);
    const previousBlobKey = user.profile_photo_blob_key;

    if (previousBlobKey === null) {
        return { cleared: true, previous_blob_key: null };
    }

    user.profile_photo_blob_key = null;
    await user.save();

    if (isAzureConfigured()) {
        await deleteBlob(AZURE_BLOB_PROFILE_PHOTOS_CONTAINER, previousBlobKey);
    } else {
        logger.warn(
            { code: 'STORAGE_NOT_CONFIGURED', user_id: user._id.toString() },
            'Profile photo cleared but blob delete skipped — Azure not configured'
        );
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.USER_PROFILE_PHOTO_CLEAR,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: user._id },
            metadata: { previous_blob_key: previousBlobKey },
        });
    }

    return { cleared: true, previous_blob_key: previousBlobKey };
};

// ─── Read SAS minting (used by user serialisers) ─────────────────────────

const ttlOrDefault = (ttl: SasTtl): number => ttl.downloadMinutes;

/**
 * Sign a short-lived read SAS URL for a stored profile photo blob_key.
 *
 *  - Returns `null` when the user has no photo set.
 *  - Returns `null` (not a 503) when Azure isn't configured. Callers
 *    serialising users for `/auth/me`, `/users/:id`, `GET /users` must
 *    not fail when the platform is being bootstrapped without storage —
 *    a missing avatar is the correct fallback.
 *  - Otherwise returns a SAS URL that the FE can drop straight into an
 *    `<img src>` until `expires_at`.
 */
export const signProfilePhotoUrl = (blobKey: string | null, ttlMinutes: number): string | null => {
    if (!blobKey || !isAzureConfigured()) return null;
    try {
        const minted = mintDownloadSas({
            container: AZURE_BLOB_PROFILE_PHOTOS_CONTAINER,
            blobKey,
            ttlMinutes,
            // No `fileName` here — profile photos are designed to be
            // rendered inline in `<img>`. The MIME allowlist excludes
            // scriptable types, and the upload-time content-type pin
            // means the stored blob is exactly what the user uploaded.
        });
        return minted.url;
    } catch (err) {
        logger.warn(
            { err, code: 'PROFILE_PHOTO_SIGN_FAILED', blob_key: blobKey },
            'Failed to sign profile-photo SAS URL — returning null'
        );
        return null;
    }
};

/**
 * Synchronous helper for serialisers that have already loaded the
 * settings doc once for the request. Avoids a second
 * `getOrInitSettings()` per user when listing many.
 */
export const resolveProfilePhotoTtlMinutes = (sasTokenTtlMinutes: number): number => {
    return Math.min(
        ATTACHMENT_SAS_TTL_MAX_MINUTES,
        Math.max(
            ATTACHMENT_SAS_TTL_MIN_MINUTES,
            Number.isFinite(sasTokenTtlMinutes) ? sasTokenTtlMinutes : ATTACHMENT_SAS_TTL_DEFAULT_MINUTES
        )
    );
};

import { z } from 'zod';

import { PROFILE_PHOTO_FILE_NAME_MAX, PROFILE_PHOTO_MIME_TYPE_MAX } from '../constants/profile-photo.js';

/**
 * Zod schemas for `/users/me/profile-photo*` (Step 22).
 *
 * Like Step 21, the validator only enforces shape + obvious caps; the
 * service layer does the runtime size + MIME allowlist checks against
 * the hard caps in `constants/profile-photo.ts` (which are deliberately
 * not driven by `system_settings`).
 */

// ─── POST /users/me/profile-photo-upload-url ─────────────────────────────

export const uploadUrlBodySchema = z.object({
    file_name: z.string().trim().min(1).max(PROFILE_PHOTO_FILE_NAME_MAX),
    file_size: z.number().int().positive(),
    mime_type: z.string().trim().min(1).max(PROFILE_PHOTO_MIME_TYPE_MAX),
});
export type ProfilePhotoUploadUrlBody = z.infer<typeof uploadUrlBodySchema>;

// ─── POST /users/me/profile-photo (finalize) ─────────────────────────────

export const finalizeBodySchema = z.object({
    blob_container: z.string().trim().min(1),
    blob_key: z.string().trim().min(1),
    file_name: z.string().trim().min(1).max(PROFILE_PHOTO_FILE_NAME_MAX),
    file_size: z.number().int().positive(),
    mime_type: z.string().trim().min(1).max(PROFILE_PHOTO_MIME_TYPE_MAX),
});
export type ProfilePhotoFinalizeBody = z.infer<typeof finalizeBodySchema>;

/**
 * Profile-photo upload constants (Step 22).
 *
 * Profile photos live in their own private Azure Blob container. Each
 * user has at most one current photo, identified by
 * `users.profile_photo_blob_key`. Re-uploading replaces the existing
 * pointer (best-effort delete of the old blob); deleting clears the
 * pointer and the blob.
 *
 * Photos are intentionally a much tighter surface than task attachments:
 *   - Image MIME types only — no PDFs, docs, archives. SVG is excluded
 *     because it can carry inline JS; we'd need a sanitiser before
 *     admitting it, and the v1 FE renders only raster formats anyway.
 *   - 5 MiB max. The product surface (avatar tile, list rows) tops out
 *     around 256×256 — anything bigger is wasted bandwidth.
 *
 * The `system_settings.uploads.sas_token_ttl_minutes` knob governs both
 * the upload SAS lifetime and the read SAS embedded in user
 * serialisations. Read URLs are minted on every `GET /auth/me` /
 * `GET /users/:id`, so a short TTL is fine — the FE will naturally
 * re-fetch the user before the SAS expires.
 */

// ─── Field caps ──────────────────────────────────────────────────────────

export const PROFILE_PHOTO_FILE_NAME_MAX = 255;
export const PROFILE_PHOTO_MIME_TYPE_MAX = 100;

// 5 MiB — this is the *route-level* hard cap; admins cannot widen it
// from `system_settings`. Profile photos that genuinely exceed this size
// are misconfigured uploads (raw camera output, etc.) and should be
// resized on the FE before submission.
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * MIME allowlist for profile photos. Hard-coded so the policy can't be
 * silently widened to admit `image/svg+xml` or `image/x-icon` (both are
 * scriptable in browsers) by an admin tightening unrelated settings.
 */
export const PROFILE_PHOTO_ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
]);

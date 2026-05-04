import { z } from 'zod';

import { SHARE_LINK_LIST_DEFAULT_LIMIT, SHARE_LINK_LIST_MAX_LIMIT } from '../constants/share-link.js';

/**
 * Zod schemas for `/projects/:project_id/share-links`,
 * `/share-links/:id/revoke`, and `/share-links/resolve/:token`
 * (API_Contract.md §7.5–7.6 / BUILD_PROGRESS.md Step 24).
 *
 * `expires_at` is sent by the FE as an ISO datetime string and stored
 * as a `Date` on the row — the validator does the parse here so the
 * service can trust a real `Date | null`.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

// Resolve tokens are 32 random bytes → base64url (43 chars). We accept
// the broader URL-safe-base64 alphabet to avoid coupling the validator
// to the exact length, but reject any character that couldn't possibly
// have come from the generator (control bytes, slashes — base64url
// uses `-` and `_` only).
const tokenSchema = z
    .string()
    .min(16, 'Share-link token is too short')
    .max(128, 'Share-link token is too long')
    .regex(/^[A-Za-z0-9_-]+$/, 'Token must be base64url-safe');

// ─── POST /projects/:project_id/share-links ──────────────────────────────

// Both fields are optional. The validate middleware coerces an
// absent body to `{}` for object schemas, so an empty POST works
// without a top-level `.default(...)` (which Zod 4 doesn't accept
// as `{}` against a non-empty inner shape).
export const createShareLinkBodySchema = z.object({
    /**
     * Optional. When omitted (or null), the link is a "generic
     * share" — Data_Model §5.8: only an admin revoke can disable
     * it; the auto-revoke cascade on client deactivation has no
     * subject to match against.
     */
    owner_client_id: objectIdSchema.nullable().optional().default(null),
    /**
     * Optional. Null = never expires (the v1 default). Any value
     * must be in the future at create time — the service guards
     * the cross-field rule against `now`.
     */
    expires_at: z.coerce.date().nullable().optional().default(null),
});
export type CreateShareLinkBody = z.infer<typeof createShareLinkBodySchema>;

// ─── GET /projects/:project_id/share-links ───────────────────────────────

export const listShareLinksQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(SHARE_LINK_LIST_MAX_LIMIT).default(SHARE_LINK_LIST_DEFAULT_LIMIT),
    /**
     * `active_only=true` filters out revoked + expired rows. Default is
     * "show everything" so the admin UI can render the audit trail of
     * past links on the project settings screen without a second call.
     */
    active_only: z.coerce.boolean().optional().default(false),
});
export type ListShareLinksQuery = z.infer<typeof listShareLinksQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const projectIdPathSchema = z.object({ project_id: objectIdSchema });
export type ProjectIdPath = z.infer<typeof projectIdPathSchema>;

export const shareLinkIdPathSchema = z.object({ id: objectIdSchema });
export type ShareLinkIdPath = z.infer<typeof shareLinkIdPathSchema>;

export const shareLinkTokenPathSchema = z.object({ token: tokenSchema });
export type ShareLinkTokenPath = z.infer<typeof shareLinkTokenPathSchema>;

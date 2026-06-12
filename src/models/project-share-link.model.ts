import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { SHARE_LINK_REVOKE_REASONS, type ShareLinkRevokeReason } from '../constants/share-link.js';

/**
 * `project_share_links` — Data_Model.md §5.8.
 *
 * Read-only public access. The token IS the credential — anyone with the
 * URL gets read-only project access until the link is revoked or
 * expires. This model is small on purpose:
 *
 *  - `revoked_at`/`revoked_by`/`revoke_reason` capture WHO disabled the
 *    link and WHY (manual admin revoke vs. auto-revoke from a client
 *    deactivation), so the Step-31 audit UI can render an intelligible
 *    history without a separate revoke-events collection.
 *  - `last_accessed_at` is a single timestamp, not an event log. If
 *    per-visit auditing is ever needed (Data_Model.md §11 follow-up #3),
 *    a `share_link_accesses` collection can be added without changing
 *    this row.
 *
 * Token (`SHARE_LINK_TOKEN_BYTES = 32`) is generated server-side via
 * `crypto.randomBytes` → base64url, ~256 bits of entropy.
 *
 * C9 — Pre-fix the raw token was persisted in `token` and queried
 * directly by `findOne({ token })`. Any read-only DB exposure (backup,
 * replica access, mongo-express misconfig, BSON dump in a log line)
 * handed an attacker live ungated read access to every project the
 * link grants. Post-fix only the SHA-256 hex hash is persisted in
 * `token_hash`; the raw token is returned ONCE in the create response
 * and lives in the URL the admin shares — never in the DB. Mirrors the
 * password-reset + refresh-token pattern. `token` is kept as a
 * nullable transitional field so the boot-time migration can backfill
 * legacy plaintext rows; new rows always have `token: null`.
 */

export interface ProjectShareLinkDocument extends Document {
    _id: Types.ObjectId;
    project_id: Types.ObjectId;
    /** SHA-256 hex of the raw token. Source of truth for lookups. */
    token_hash: string;
    /**
     * AES-256-GCM encrypted form of the raw token (same key as the
     * Slack bot_token). Allows authed admins (`share_link.write`) to
     * recover the raw token for the Copy-URL action. Old rows that were
     * created before this field was added will have null here; the list
     * endpoint surfaces `token: null` for those rows so the Copy button
     * is hidden. Never sent to public resolve / audit paths.
     */
    token_encrypted: string | null;
    /**
     * Legacy plaintext token. Pre-C9 rows still carry one; the boot
     * migration hashes them into `token_hash` and clears this field.
     * New rows never set this. Will be removed in a follow-up release
     * once every deployment has booted with the migration at least once.
     */
    token: string | null;
    owner_client_id: Types.ObjectId | null;
    created_by: Types.ObjectId;
    expires_at: Date | null;
    revoked_at: Date | null;
    revoked_by: Types.ObjectId | null;
    revoke_reason: ShareLinkRevokeReason | null;
    last_accessed_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const projectShareLinkSchema = new Schema<ProjectShareLinkDocument>(
    {
        project_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.PROJECTS,
            required: true,
            index: true,
        },
        token_hash: {
            type: String,
            required: true,
            trim: true,
        },
        token_encrypted: {
            type: String,
            default: null,
            // NOT indexed — ciphertext is opaque; lookups always use token_hash.
        },
        token: {
            type: String,
            default: null,
            trim: true,
        },
        owner_client_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            default: null,
            // Indexed because the user-deactivation cascade fires
            // `find({ owner_client_id, revoked_at: null })`.
            index: true,
        },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        expires_at: { type: Date, default: null },
        revoked_at: { type: Date, default: null },
        revoked_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        revoke_reason: {
            type: String,
            enum: [...Object.values(SHARE_LINK_REVOKE_REASONS), null],
            default: null,
        },
        last_accessed_at: { type: Date, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.PROJECT_SHARE_LINKS,
    }
);

// Token uniqueness — birthday risk is astronomical at 256 bits of
// entropy, but the index is cheap and turns the impossible into a
// clean retry path. Index moved from `token` to `token_hash` (C9) so
// the unique constraint applies to the hashed form; the legacy
// `token` field is now nullable + unindexed (read by the boot
// migration only).
projectShareLinkSchema.index({ token_hash: 1 }, { unique: true, name: 'project_share_links_token_hash_unique' });

export const ProjectShareLink: Model<ProjectShareLinkDocument> = model<ProjectShareLinkDocument>(
    'ProjectShareLink',
    projectShareLinkSchema
);

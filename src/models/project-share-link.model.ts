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
 * `crypto.randomBytes` → base64url, ~256 bits of entropy. The unique
 * index makes collisions a deterministic 11000 retry rather than a
 * silent overwrite.
 */

export interface ProjectShareLinkDocument extends Document {
    _id: Types.ObjectId;
    project_id: Types.ObjectId;
    token: string;
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
        token: {
            type: String,
            required: true,
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
// clean retry path.
projectShareLinkSchema.index({ token: 1 }, { unique: true, name: 'project_share_links_token_unique' });

export const ProjectShareLink: Model<ProjectShareLinkDocument> = model<ProjectShareLinkDocument>(
    'ProjectShareLink',
    projectShareLinkSchema
);

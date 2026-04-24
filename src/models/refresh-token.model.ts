import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `refresh_tokens` — Data_Model.md §1.2
 *
 * Tracks active refresh tokens for multi-device login. Stores only a **hash**
 * of the token (SHA-256). Rotation + reuse-detection rules:
 *
 *  - Every use of a refresh token mints a NEW token and rotates the old one:
 *    the old row gets `revoked_at` set and `replaced_by_token_id` pointing at
 *    the new row, and a new row with a fresh `token_hash` is inserted.
 *  - If a token arrives that is already `revoked_at != null` AND
 *    `replaced_by_token_id != null`, treat as theft: revoke the entire chain
 *    for that `user_id`.
 *  - Revocation triggers: logout (single token), password change/reset
 *    (all tokens for user), deactivation (all tokens for user).
 */
export interface RefreshTokenDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    token_hash: string;
    device_info: string;
    ip_address: string;
    expires_at: Date;
    revoked_at: Date | null;
    replaced_by_token_id: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenDocument>(
    {
        user_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: true,
            index: true,
        },
        token_hash: { type: String, required: true, unique: true },
        device_info: { type: String, default: '' },
        ip_address: { type: String, default: '' },
        expires_at: { type: Date, required: true },
        revoked_at: { type: Date, default: null },
        replaced_by_token_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.REFRESH_TOKENS,
            default: null,
        },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.REFRESH_TOKENS,
    }
);

// TTL index — Mongo auto-removes rows where `expires_at` is in the past.
refreshTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken: Model<RefreshTokenDocument> = model<RefreshTokenDocument>(
    COLLECTIONS.REFRESH_TOKENS,
    refreshTokenSchema
);

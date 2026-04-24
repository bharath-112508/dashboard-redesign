import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `password_reset_tokens` — Data_Model.md §1.3
 *
 * The plaintext token travels in the email link; only its SHA-256 hash is
 * stored here. That way a DB leak (or an operator reading Mongo) cannot replay
 * the link. Tokens are single-use (`used_at` stamped on reset) and auto-expire
 * via the TTL index on `expires_at` — typically 1 hour after creation.
 *
 * Requesting a new reset invalidates all of the user's older unused tokens so
 * only the most recent link works (standard UX and a gentle mitigation for
 * phished-but-unused links).
 */

export interface PasswordResetTokenDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    token_hash: string;
    expires_at: Date;
    used_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const passwordResetTokenSchema = new Schema<PasswordResetTokenDocument>(
    {
        user_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: true,
            index: true,
        },
        token_hash: { type: String, required: true, unique: true },
        expires_at: { type: Date, required: true },
        used_at: { type: Date, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.PASSWORD_RESET_TOKENS,
    }
);

// TTL index — Mongo auto-removes rows whose `expires_at` has passed.
passwordResetTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetToken: Model<PasswordResetTokenDocument> = model<PasswordResetTokenDocument>(
    COLLECTIONS.PASSWORD_RESET_TOKENS,
    passwordResetTokenSchema
);

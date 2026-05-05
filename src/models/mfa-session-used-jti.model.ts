import { Schema, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `mfa_session_used_jtis` (BACKEND_AUDIT.md R10).
 *
 * Replay guard for the short-lived MFA-session JWTs issued between
 * `POST /auth/login` (with mfa_enabled) and `POST /auth/mfa/verify`.
 * Without this collection, a stolen mfa_session_token could be
 * replayed against `/mfa/verify` until its 5-minute TTL expires.
 *
 * Lifecycle:
 *   1. `mfa.service.verify` decodes the JWT, validates the TOTP /
 *      backup code, then atomically inserts a row keyed by the
 *      JWT's `jti`. The unique index turns a replay into a clean
 *      E11000 → `MFA_SESSION_REPLAY` rejection.
 *   2. Each row has `expires_at` set to the JWT's `exp` claim. The
 *      Mongo TTL index removes the row at that timestamp so the
 *      collection stays bounded; rows older than the JWT's TTL
 *      can never collide with a fresh token (the JWT verifier
 *      would reject the expired token first).
 *
 * Design note: we key by `jti` (a ULID) rather than the full token
 * because the token can be large and reproducing it on every verify
 * costs no security but burns a few KB per row.
 */

export interface MfaSessionUsedJtiDocument extends Document {
    jti: string;
    expires_at: Date;
    created_at: Date;
    updated_at: Date;
}

const mfaSessionUsedJtiSchema = new Schema<MfaSessionUsedJtiDocument>(
    {
        jti: { type: String, required: true, unique: true },
        // TTL index — Mongo removes the row when wall-clock reaches
        // `expires_at`. `expireAfterSeconds: 0` is the standard form
        // that means "the field VALUE is the absolute expiry time".
        expires_at: { type: Date, required: true, expires: 0 },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.MFA_SESSION_USED_JTIS,
    }
);

export const MfaSessionUsedJti: Model<MfaSessionUsedJtiDocument> = model<MfaSessionUsedJtiDocument>(
    COLLECTIONS.MFA_SESSION_USED_JTIS,
    mfaSessionUsedJtiSchema
);

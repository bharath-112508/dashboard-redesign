import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `push_subscriptions` — V2-BE-10.
 *
 * One document per (user, browser-endpoint) pair. The Web Push API
 * issues a unique endpoint URL per browser install per registration;
 * users can have several (laptop + phone + tablet) and each gets its
 * own row.
 *
 * Why a separate collection (not a sub-doc on User):
 *  - The dispatcher fan-out looks up subscriptions per recipient as an
 *    indexed query — a `{ user_id: 1 }` index covers the hot path.
 *  - Subscriptions churn independently of the user doc (browsers expire
 *    endpoints, users reinstall) — keeping them out avoids rewriting the
 *    User document on every refresh.
 *  - Stale-endpoint pruning (when the push service returns 410) needs
 *    to be a cheap deleteOne, not a `$pull` on the User doc.
 *
 * The Push API guarantees endpoint uniqueness globally, but we enforce
 * `(user_id, endpoint)` uniqueness at the DB level so two users on the
 * same machine + browser profile each get their own row (rare but
 * possible — endpoint changes when the subscription is re-created).
 */

export interface PushSubscriptionKeys {
    /** P-256 ECDH public key (browser-side). */
    p256dh: string;
    /** Auth secret (16 random bytes, base64url). */
    auth: string;
}

export interface PushSubscriptionDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    /** Full push-service URL. The provider (Chrome FCM, Mozilla autopush,
     *  Apple APNs) is determined by the host. */
    endpoint: string;
    keys: PushSubscriptionKeys;
    /** UA string at registration time — for the "your subscriptions" UI
     *  + debugging stale-endpoint sources. Optional. */
    user_agent: string | null;
    /** ISO timestamp of the last successful dispatch. Helpful for
     *  pruning visibly-dead subscriptions on a janitor cron. */
    last_used_at: Date | null;
    /** ISO timestamp of the last push-service failure that wasn't a
     *  permanent 410/404 (those rows are deleted immediately). */
    last_error_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const keysSchema = new Schema<PushSubscriptionKeys>(
    {
        p256dh: { type: String, required: true, trim: true, maxlength: 256 },
        auth: { type: String, required: true, trim: true, maxlength: 64 },
    },
    { _id: false }
);

const pushSubscriptionSchema = new Schema<PushSubscriptionDocument>(
    {
        user_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: true,
            index: true,
        },
        endpoint: {
            type: String,
            required: true,
            trim: true,
            // Push endpoints can be long (FCM URLs run ~500 chars);
            // 2 KB is comfortably above what any real provider emits.
            maxlength: 2048,
        },
        keys: { type: keysSchema, required: true },
        user_agent: { type: String, required: false, default: null, trim: true, maxlength: 512 },
        last_used_at: { type: Date, required: false, default: null },
        last_error_at: { type: Date, required: false, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.PUSH_SUBSCRIPTIONS,
    }
);

// Compound uniqueness on (user_id, endpoint). Endpoints from a single
// browser are stable for the life of the registration, so this makes
// the re-subscribe path idempotent: an upsert collapses to "no-op" when
// the same endpoint is offered again.
pushSubscriptionSchema.index({ user_id: 1, endpoint: 1 }, { unique: true });

export const PushSubscription: Model<PushSubscriptionDocument> = model<PushSubscriptionDocument>(
    COLLECTIONS.PUSH_SUBSCRIPTIONS,
    pushSubscriptionSchema
);

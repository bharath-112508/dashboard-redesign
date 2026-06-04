import { Types } from 'mongoose';

import {
    PushSubscription,
    type PushSubscriptionDocument,
    type PushSubscriptionKeys,
} from '../models/push-subscription.model.js';

/**
 * Push-subscription service (V2-BE-10).
 *
 * Thin CRUD layer. Permission checks happen at the controller
 * (the route is gated by `authenticate`, and every operation is
 * keyed to the caller's user_id) — there is no admin path; users
 * can only see / mutate their own subscriptions.
 *
 * `upsertSubscription` is idempotent: repeated calls with the same
 * `(user_id, endpoint)` collapse to no-ops, which lets the FE
 * register-on-every-mount without producing duplicate rows.
 */

export interface UpsertSubscriptionInput {
    user_id: Types.ObjectId;
    endpoint: string;
    keys: PushSubscriptionKeys;
    user_agent?: string | null;
}

export const upsertSubscription = async (
    input: UpsertSubscriptionInput
): Promise<PushSubscriptionDocument> => {
    // `findOneAndUpdate` with `upsert: true` is the idempotency
    // primitive — the unique compound index `(user_id, endpoint)` on
    // the model guarantees we never grow duplicate rows for the same
    // browser endpoint, even under concurrent re-subscribes from
    // multiple tabs.
    const doc = await PushSubscription.findOneAndUpdate(
        { user_id: input.user_id, endpoint: input.endpoint },
        {
            $set: {
                keys: input.keys,
                user_agent: input.user_agent ?? null,
            },
            $setOnInsert: {
                user_id: input.user_id,
                endpoint: input.endpoint,
            },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return doc;
};

/**
 * Delete one subscription by its endpoint, scoped to the caller. Used
 * by the FE when the user toggles the browser-notifications switch off
 * OR un-installs the PWA. The unique `(user_id, endpoint)` index makes
 * this exact-match by design.
 *
 * Returns `{ deleted: number }` so the controller can decide between
 * 204 (deleted) and 404 (wasn't there) if it wants — current contract
 * just returns 204 either way (idempotent unsubscribe).
 */
export const deleteSubscriptionByEndpoint = async (
    user_id: Types.ObjectId,
    endpoint: string
): Promise<{ deleted: number }> => {
    const result = await PushSubscription.deleteOne({ user_id, endpoint });
    return { deleted: result.deletedCount ?? 0 };
};

/**
 * List active subscriptions for a user. Used by the dispatcher to
 * fan-out per recipient. Read-only — no caller authorisation needed
 * because the dispatcher only ever queries by the recipient's own id.
 */
export const listSubscriptionsForUser = async (
    user_id: Types.ObjectId
): Promise<PushSubscriptionDocument[]> => {
    return PushSubscription.find({ user_id }).lean<PushSubscriptionDocument[]>();
};

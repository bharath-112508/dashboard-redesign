import { Types } from 'mongoose';

import {
    PushSubscription,
    type PushSubscriptionDocument,
    type PushSubscriptionKeys,
} from '../models/push-subscription.model.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';

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
    /** H6 — passed through from the controller so each upsert emits a
     *  `push_subscription.create` audit row. Optional so the dispatcher
     *  and other internal callers (none today) can skip auditing. */
    audit?: AuditContext;
}

export const upsertSubscription = async (input: UpsertSubscriptionInput): Promise<PushSubscriptionDocument> => {
    // `findOneAndUpdate` with `upsert: true` is the idempotency
    // primitive — the unique compound index `(user_id, endpoint)` on
    // the model guarantees we never grow duplicate rows for the same
    // browser endpoint, even under concurrent re-subscribes from
    // multiple tabs.
    const existing = await PushSubscription.findOne({
        user_id: input.user_id,
        endpoint: input.endpoint,
    }).select('_id');
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

    // H6 — only audit the actual subscribe (insert), not the
    // idempotent re-subscribe upsert. The dispatcher fan-out doesn't
    // need a row per re-mount; ops only care about the
    // "browser X was first registered at T" event.
    if (input.audit && !existing) {
        await recordAudit(input.audit, {
            action: AUDIT_ACTIONS.PUSH_SUBSCRIPTION_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.PUSH_SUBSCRIPTION, id: doc._id },
            after: {
                user_id: doc.user_id.toString(),
                endpoint_host: safeEndpointHost(doc.endpoint),
            },
            metadata: { user_agent: doc.user_agent ?? null },
        });
    }
    return doc;
};

/**
 * Hostname-only projection of the endpoint. The full URL contains a
 * subscription ID path component that's effectively a secret; only the
 * push-service hostname is recorded in audit metadata.
 */
const safeEndpointHost = (endpoint: string): string => {
    try {
        return new URL(endpoint).hostname;
    } catch {
        return 'invalid-url';
    }
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
    endpoint: string,
    audit?: AuditContext
): Promise<{ deleted: number }> => {
    // H6 — capture the row's _id BEFORE deletion so the audit row
    // points at a known target. The unsubscribe is idempotent: a
    // miss returns `{ deleted: 0 }` and we skip the audit emission
    // (no event happened).
    const existing = await PushSubscription.findOne({ user_id, endpoint }).select('_id user_agent');
    const result = await PushSubscription.deleteOne({ user_id, endpoint });
    const deleted = result.deletedCount ?? 0;
    if (audit && existing && deleted > 0) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.PUSH_SUBSCRIPTION_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.PUSH_SUBSCRIPTION, id: existing._id },
            before: {
                user_id: user_id.toString(),
                endpoint_host: safeEndpointHost(endpoint),
            },
            metadata: { user_agent: existing.user_agent ?? null },
        });
    }
    return { deleted };
};

/**
 * List active subscriptions for a user. Used by the dispatcher to
 * fan-out per recipient. Read-only — no caller authorisation needed
 * because the dispatcher only ever queries by the recipient's own id.
 */
export const listSubscriptionsForUser = async (user_id: Types.ObjectId): Promise<PushSubscriptionDocument[]> => {
    return PushSubscription.find({ user_id }).lean<PushSubscriptionDocument[]>();
};

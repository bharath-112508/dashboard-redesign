import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/push-subscription.service.js';
import { noContent, ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type {
    SubscribePushBody,
    UnsubscribePushBody,
} from '../validators/push-subscription.validator.js';

/**
 * Push subscription controllers (V2-BE-10).
 *
 * Surface:
 *   - POST   /push/subscribe    register or refresh a browser endpoint
 *   - DELETE /push/subscribe    revoke a browser endpoint (idempotent)
 *
 * Every call is owner-scoped: the caller's user_id from the JWT is the
 * only allowed `user_id` for the subscription. There is no admin path —
 * subscriptions are inherently per-browser-per-user, and exposing
 * "list a user's subscriptions" would create a small surveillance
 * primitive for negligible operational value.
 */

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return new Types.ObjectId(req.user.user_id);
};

// ─── POST /push/subscribe ─────────────────────────────────────────────────

export const postSubscribe = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as SubscribePushBody;
    const sub = await service.upsertSubscription({
        user_id: callerId(req),
        endpoint: body.endpoint,
        keys: body.keys,
        user_agent: body.user_agent ?? req.headers['user-agent'] ?? null,
    });
    return ok(res, {
        id: sub._id.toString(),
        endpoint: sub.endpoint,
        created_at: sub.created_at.toISOString(),
    });
};

// ─── DELETE /push/subscribe ───────────────────────────────────────────────

export const deleteSubscribe = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as UnsubscribePushBody;
    await service.deleteSubscriptionByEndpoint(callerId(req), body.endpoint);
    // Idempotent — 204 even if there was no matching row.
    return noContent(res);
};

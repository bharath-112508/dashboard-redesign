import type { Request } from 'express';
import { Types } from 'mongoose';

import type { AuditContext } from '../services/audit.service.js';
import type { AuditActorRole } from '../constants/audit.js';
import type { RoleType } from '../constants/roles.js';

/**
 * Build an `AuditContext` from an Express request.
 *
 *  - When the route is authenticated (`req.user` is present), the actor's
 *    `user_id` + `role` snapshot are recorded as-is.
 *  - When the route is unauthenticated (forgot-password / reset-password),
 *    the caller may supply an `overrideActor` so the audit row still ties
 *    back to the user the action was performed against. Without that, the
 *    actor is recorded as `'unauthenticated'`.
 *
 * IP + user-agent are sliced (UA only) to keep audit rows small. The IP
 * resolution mirrors the existing controller helpers (`req.ip` first, then
 * `req.socket.remoteAddress`); `trust proxy` set in `index.ts` makes
 * `req.ip` the client IP rather than the proxy.
 */
export interface ExtractCtxOptions {
    /**
     * Replace the actor derived from `req.user`. Used by unauthenticated
     * routes (e.g. `/auth/reset-password`) where the actor is known *after*
     * the token is validated, not from the auth middleware.
     */
    overrideActor?: {
        actor_id: Types.ObjectId | null;
        actor_role: AuditActorRole;
    };
}

const ipOf = (req: Request): string | null => {
    const ip = req.ip ?? req.socket?.remoteAddress;
    return ip ? String(ip) : null;
};

const userAgentOf = (req: Request): string | null => {
    const ua = req.headers['user-agent'];
    if (!ua) return null;
    return String(ua).slice(0, 512);
};

export const buildAuditContext = (req: Request, opts: ExtractCtxOptions = {}): AuditContext => {
    if (opts.overrideActor) {
        return {
            actor_id: opts.overrideActor.actor_id,
            actor_role: opts.overrideActor.actor_role,
            ip: ipOf(req),
            user_agent: userAgentOf(req),
        };
    }

    if (req.user?.user_id) {
        return {
            actor_id: new Types.ObjectId(req.user.user_id),
            actor_role: req.user.role as RoleType,
            ip: ipOf(req),
            user_agent: userAgentOf(req),
        };
    }

    return {
        actor_id: null,
        actor_role: 'unauthenticated',
        ip: ipOf(req),
        user_agent: userAgentOf(req),
    };
};

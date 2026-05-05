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

/**
 * T2 — extract the request id minted by `pino-http` (or the inbound
 * `x-request-id` header it propagates). Stored on every audit row so
 * an investigator can pivot from a pino HTTP log line to the
 * audit row that recorded the side-effect — the use case the schema
 * was designed for.
 */
const requestIdOf = (req: Request): string | null => {
    // `pino-http` types `req.id` as `string | undefined` on its own
    // augmented Request, but we don't depend on those types here so
    // we read it loosely.
    const id = (req as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
    const header = req.headers['x-request-id'];
    if (typeof header === 'string' && header.length > 0) return header;
    return null;
};

export const buildAuditContext = (req: Request, opts: ExtractCtxOptions = {}): AuditContext => {
    const request_id = requestIdOf(req);

    if (opts.overrideActor) {
        return {
            actor_id: opts.overrideActor.actor_id,
            actor_role: opts.overrideActor.actor_role,
            ip: ipOf(req),
            user_agent: userAgentOf(req),
            request_id,
        };
    }

    if (req.user?.user_id) {
        return {
            actor_id: new Types.ObjectId(req.user.user_id),
            actor_role: req.user.role as RoleType,
            ip: ipOf(req),
            user_agent: userAgentOf(req),
            request_id,
        };
    }

    return {
        actor_id: null,
        actor_role: 'unauthenticated',
        ip: ipOf(req),
        user_agent: userAgentOf(req),
        request_id,
    };
};

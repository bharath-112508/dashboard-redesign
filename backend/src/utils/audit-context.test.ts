import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';

import { buildAuditContext } from './audit-context.js';

/**
 * Pins the contract for `buildAuditContext`, especially the T2 fix —
 * `request_id` was declared on `AuditContext` since day one but never
 * populated by any branch, so every audit row stored
 * `metadata.request_id: undefined`.
 */

const makeReq = (overrides: Record<string, unknown> = {}) => ({
    ip: '127.0.0.1',
    headers: { 'user-agent': 'curl' },
    socket: {},
    user: undefined,
    ...overrides,
});

describe('buildAuditContext', () => {
    // ─── Actor resolution ──────────────────────────────────────────────

    it('resolves the actor from req.user when authenticated', () => {
        const userId = new Types.ObjectId();
        const ctx = buildAuditContext(makeReq({ user: { user_id: userId.toString(), role: 'admin' } }) as never);
        expect(ctx.actor_id?.toString()).toBe(userId.toString());
        expect(ctx.actor_role).toBe('admin');
    });

    it('returns unauthenticated when req.user is missing', () => {
        const ctx = buildAuditContext(makeReq() as never);
        expect(ctx.actor_id).toBeNull();
        expect(ctx.actor_role).toBe('unauthenticated');
    });

    it('honours overrideActor for unauthenticated routes (e.g. password reset)', () => {
        const userId = new Types.ObjectId();
        const ctx = buildAuditContext(makeReq() as never, {
            overrideActor: { actor_id: userId, actor_role: 'employee' },
        });
        expect(ctx.actor_id?.toString()).toBe(userId.toString());
        expect(ctx.actor_role).toBe('employee');
    });

    // ─── T2: request_id propagation ────────────────────────────────────

    it('T2 — populates request_id from req.id (the pino-http mint)', () => {
        const ctx = buildAuditContext(
            makeReq({ id: '01HXXX...REQUEST', user: { user_id: '6500000000000000000000aa', role: 'admin' } }) as never
        );
        expect(ctx.request_id).toBe('01HXXX...REQUEST');
    });

    it('T2 — falls back to x-request-id header when req.id is unset', () => {
        const ctx = buildAuditContext(
            makeReq({
                headers: { 'user-agent': 'curl', 'x-request-id': 'inbound-trace-id' },
                user: { user_id: '6500000000000000000000aa', role: 'admin' },
            }) as never
        );
        expect(ctx.request_id).toBe('inbound-trace-id');
    });

    it('T2 — request_id is null when neither req.id nor the header is set', () => {
        const ctx = buildAuditContext(
            makeReq({ user: { user_id: '6500000000000000000000aa', role: 'admin' } }) as never
        );
        expect(ctx.request_id).toBeNull();
    });

    it('T2 — request_id flows through ALL three branches (authenticated / overrideActor / unauthenticated)', () => {
        const reqWithId = makeReq({ id: 'trace-1', user: { user_id: '6500000000000000000000aa', role: 'admin' } });
        const authed = buildAuditContext(reqWithId as never);
        expect(authed.request_id).toBe('trace-1');

        const overridden = buildAuditContext(reqWithId as never, {
            overrideActor: { actor_id: new Types.ObjectId(), actor_role: 'employee' },
        });
        expect(overridden.request_id).toBe('trace-1');

        const anonReq = makeReq({ id: 'trace-2' });
        const anon = buildAuditContext(anonReq as never);
        expect(anon.request_id).toBe('trace-2');
    });

    it('T2 — empty-string req.id is treated as missing (falls back through to header / null)', () => {
        const ctx = buildAuditContext(makeReq({ id: '', headers: { 'user-agent': 'curl' } }) as never);
        expect(ctx.request_id).toBeNull();
    });
});

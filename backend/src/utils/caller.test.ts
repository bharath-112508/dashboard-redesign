import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { ROLES } from '../constants/roles.js';
import { projectCallerFrom } from './caller.js';

/**
 * Pins the contract for the single caller-construction site.
 *
 * The `company_id` assertions matter most: a `client`'s project visibility
 * is driven by that field, so if it silently fails to reach the caller the
 * filter degrades to "no company" — which is why the eleven per-controller
 * `callerOf` locals were collapsed into this one helper.
 */

const makeReq = (overrides: Record<string, unknown> = {}) =>
    ({
        ip: '127.0.0.1',
        headers: { 'user-agent': 'curl' },
        socket: {},
        user: {
            user_id: new Types.ObjectId().toHexString(),
            role: ROLES.EMPLOYEE,
            role_keys: [ROLES.EMPLOYEE],
            permissions: [],
        },
        ...overrides,
    }) as never;

describe('projectCallerFrom', () => {
    it('builds the caller from req.user', () => {
        const userId = new Types.ObjectId();
        const caller = projectCallerFrom(
            makeReq({
                user: {
                    user_id: userId.toHexString(),
                    role: ROLES.MANAGER,
                    role_keys: [ROLES.MANAGER],
                    permissions: [],
                },
            })
        );

        expect(caller.id.equals(userId)).toBe(true);
        expect(caller.role).toBe(ROLES.MANAGER);
        expect(caller.role_keys).toEqual([ROLES.MANAGER]);
    });

    it('carries role_keys so isAdminLike sees a multi-role admin (R4)', () => {
        const caller = projectCallerFrom(
            makeReq({
                user: {
                    user_id: new Types.ObjectId().toHexString(),
                    // Legacy denormalized `role` cache says employee...
                    role: ROLES.EMPLOYEE,
                    // ...but the caller really is an admin.
                    role_keys: [ROLES.EMPLOYEE, ROLES.ADMIN],
                    permissions: [],
                },
            })
        );

        expect(caller.role_keys).toContain(ROLES.ADMIN);
    });

    // ─── company_id — the client visibility boundary ────────────────────

    it('carries caller_company_id, which authenticate sets from the DB row', () => {
        const companyId = new Types.ObjectId();
        const caller = projectCallerFrom(
            makeReq({
                user: {
                    user_id: new Types.ObjectId().toHexString(),
                    role: ROLES.CLIENT,
                    role_keys: [ROLES.CLIENT],
                    permissions: [],
                },
                caller_company_id: companyId,
            })
        );

        expect(caller.company_id?.equals(companyId)).toBe(true);
    });

    it('leaves company_id undefined for staff roles', () => {
        expect(projectCallerFrom(makeReq()).company_id).toBeUndefined();
    });

    it('never reads company_id from the JWT payload', () => {
        // A forged/stale token claiming a company must not grant company
        // scope — only `authenticate`'s DB read may set it.
        const forged = new Types.ObjectId();
        const caller = projectCallerFrom(
            makeReq({
                user: {
                    user_id: new Types.ObjectId().toHexString(),
                    role: ROLES.CLIENT,
                    role_keys: [ROLES.CLIENT],
                    permissions: [],
                    company_id: forged,
                    client_profile: { company_id: forged },
                },
            })
        );

        expect(caller.company_id).toBeUndefined();
    });

    // ─── Guards ─────────────────────────────────────────────────────────

    it('rejects an unauthenticated request', () => {
        expect(() => projectCallerFrom(makeReq({ user: undefined }))).toThrow();
    });

    it('rejects a payload with no role', () => {
        expect(() => projectCallerFrom(makeReq({ user: { user_id: new Types.ObjectId().toHexString() } }))).toThrow();
    });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `auth.middleware` — Step 28 force-MFA-for-admins gate.
 *
 * The middleware composes two responsibilities:
 *   1. JWT verification (existed before Step 28).
 *   2. The MFA gate that, when `system_settings.security.require_mfa_for_admins`
 *      is on, blocks admin role + write method + `mfa_enabled=false` with
 *      403 `MFA_REQUIRED`.
 *
 * Coverage focus (the gate, not JWT — JWT is exercised by the smoke):
 *   - Flag OFF (default) is a true no-op for admin writes.
 *   - Flag ON + admin + write + mfa_enabled=false → 403 MFA_REQUIRED.
 *   - Flag ON + admin + write + mfa_enabled=true → passes.
 *   - Flag ON + non-admin (employee/manager/client) → passes regardless of MFA.
 *   - Flag ON + admin + GET/HEAD/OPTIONS → passes (reads bypass).
 *   - Flag ON + admin + POST `/mfa/setup/init` and `/mfa/setup/confirm` →
 *     passes (chicken-and-egg exemption — admin must be able to enrol).
 *   - Brick-safety regression: a no-MFA admin trying to PATCH /settings
 *     when the flag is on is still blocked, so they cannot accidentally
 *     re-toggle the flag without first enabling MFA.
 */

const { verifyAccessTokenMock, userFindByIdMock, getOrInitSettingsMock } = vi.hoisted(() => ({
    verifyAccessTokenMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    getOrInitSettingsMock: vi.fn(),
}));

vi.mock('../utils/jwt.js', () => ({
    verifyAccessToken: verifyAccessTokenMock,
}));

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock },
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: getOrInitSettingsMock,
}));

const middleware = await import('./auth.middleware.js');
import { ROLES } from '../constants/roles.js';
import { ERROR_CODES } from '../constants/error-codes.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const adminId = new Types.ObjectId();
const employeeId = new Types.ObjectId();

interface ReqLike {
    headers: { authorization?: string };
    method: string;
    path: string;
    user?: { user_id: string; role: string };
}

const makeReq = (overrides: Partial<ReqLike> = {}): ReqLike => ({
    headers: { authorization: 'Bearer fake-jwt' },
    method: 'POST',
    path: '/users',
    ...overrides,
});

const settingsWithFlag = (require_mfa_for_admins: boolean) => ({
    security: { require_mfa_for_admins },
});

// Records the exact arg passed to `.select(...)` so a future regression
// that fetches the full user doc (PII bloat / perf cost) is caught at
// the test layer, not by an audit reviewer noticing logs.
//
// T1: the middleware reads `status` + `mfa_enabled` in a single findById,
// so the mock factory accepts both fields and defaults to `status:
// 'active'` (the dominant case). The projection also carries
// `client_profile.company_id`; the mock leaves it unset, which is the
// staff-role case (undefined company scope).
const userMfaSelectArgs: string[] = [];
const userMfa = (mfa_enabled: boolean, status: string = 'active') => ({
    select: (arg: string) => {
        userMfaSelectArgs.push(arg);
        return { lean: () => Promise.resolve({ status, mfa_enabled }) };
    },
});

// A `findById(...)` chain whose terminal `.lean()` resolves to null —
// the user was deleted between JWT issue and this middleware run.
const userMfaDeleted = () => ({
    select: () => ({ lean: () => Promise.resolve(null) }),
});

const runAuthenticate = async (req: ReqLike): Promise<{ ok: boolean; err?: unknown }> => {
    return new Promise((resolve) => {
        // The Express `next` callback is invoked with no arg on success
        // and with an error on failure. The middleware also throws —
        // wrap in a try/catch + the next-callback to handle both.
        const next = (err?: unknown): void => {
            resolve({ ok: !err, err });
        };
        Promise.resolve(middleware.authenticate(req as never, {} as never, next)).catch((err: unknown) => {
            resolve({ ok: false, err });
        });
    });
};

beforeEach(() => {
    vi.resetAllMocks();
    userMfaSelectArgs.length = 0;
    // JWT verification stub — every test reuses the same payload shape;
    // per-test overrides via `mockReturnValueOnce`.
    verifyAccessTokenMock.mockReturnValue({
        user_id: adminId.toString(),
        role: ROLES.ADMIN,
    });
    // T1 — `authenticate` now ALWAYS does a single `findById` reading
    // `status` + `mfa_enabled`. Default mock returns an active user
    // with MFA off; tests exercising deactivation / MFA-on override.
    userFindByIdMock.mockReturnValue(userMfa(false));
});

// ─── Flag OFF — true no-op ───────────────────────────────────────────────

describe('authenticate (flag OFF — default)', () => {
    it('does not even read settings when the caller is non-admin', async () => {
        verifyAccessTokenMock.mockReturnValue({
            user_id: employeeId.toString(),
            role: ROLES.EMPLOYEE,
        });

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/leaves' }));

        expect(result.ok).toBe(true);
        // Short-circuit on role — settings never loaded.
        expect(getOrInitSettingsMock).not.toHaveBeenCalled();
        // T1: `findById` IS called (status check); but only once
        // — the MFA-gate path does not hit it again.
        expect(userFindByIdMock).toHaveBeenCalledTimes(1);
    });

    it('reads settings ONCE for an admin write but no-ops when require_mfa_for_admins is false', async () => {
        getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(false));

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/users' }));

        expect(result.ok).toBe(true);
        expect(getOrInitSettingsMock).toHaveBeenCalledTimes(1);
        // T1 — `findById` runs unconditionally now (status check);
        // the MFA gate just consumes the same row.
        expect(userFindByIdMock).toHaveBeenCalledTimes(1);
    });
});

// ─── Flag ON — admin gate ────────────────────────────────────────────────

describe('authenticate (flag ON — admin gate)', () => {
    it('blocks an admin without MFA on a write request with 403 MFA_REQUIRED', async () => {
        getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(true));
        userFindByIdMock.mockReturnValueOnce(userMfa(false));

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/users' }));

        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({
            statusCode: 403,
            code: ERROR_CODES.MFA_REQUIRED,
        });
        // Lock in the projection — the gate must NOT pull the full
        // user document. A regression that drops the projection would
        // balloon the per-write payload. T1 changed the projection to
        // include `status` so the deactivate-but-token-still-valid
        // window is closed in the same query.
        expect(userMfaSelectArgs).toEqual(['status mfa_enabled client_profile.company_id']);
    });

    it('returns 401 UNAUTHENTICATED when the user row was deleted between JWT issue and middleware run', async () => {
        // T1: a token whose user_id no longer resolves is treated as
        // forged. Pre-T1 this case fell through to the MFA gate's
        // null-coalesce and returned 403 MFA_REQUIRED — the new
        // semantics are stricter and more defensible.
        userFindByIdMock.mockReturnValueOnce(userMfaDeleted());

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/users' }));

        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({ code: ERROR_CODES.UNAUTHENTICATED });
    });

    it('passes an admin WITH MFA enabled on the same write', async () => {
        getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(true));
        userFindByIdMock.mockReturnValueOnce(userMfa(true));

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/users' }));

        expect(result.ok).toBe(true);
    });

    it('does NOT gate non-admin writers regardless of their own MFA state', async () => {
        // An employee without MFA should still be able to POST/PATCH —
        // the flag is admin-only.
        getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(true));
        verifyAccessTokenMock.mockReturnValue({
            user_id: employeeId.toString(),
            role: ROLES.EMPLOYEE,
        });

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/leaves' }));

        expect(result.ok).toBe(true);
        // Settings shouldn't even be read for non-admin — the role
        // short-circuit fires first.
        expect(getOrInitSettingsMock).not.toHaveBeenCalled();
    });
});

// ─── Method bypass — reads always pass ───────────────────────────────────

describe('authenticate (method short-circuits)', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])(
        'passes an admin without MFA on %s requests when the flag is on (reads bypass)',
        async (method) => {
            // The admin's `mfa_enabled` shouldn't even be checked —
            // the read-method short-circuit fires before the settings load.
            getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(true));

            const result = await runAuthenticate(makeReq({ method, path: '/users' }));

            expect(result.ok).toBe(true);
            // Read short-circuit is BEFORE the settings load.
            expect(getOrInitSettingsMock).not.toHaveBeenCalled();
            // T1 — `findById` is called once for the status check
            // regardless of method. The MFA gate's read-method
            // short-circuit just means it doesn't read the row a
            // second time.
            expect(userFindByIdMock).toHaveBeenCalledTimes(1);
        }
    );
});

// ─── Path exemptions — chicken-and-egg ───────────────────────────────────

describe('authenticate (MFA-setup paths are exempt)', () => {
    it.each(['/mfa/setup/init', '/mfa/setup/confirm'])(
        'passes an admin without MFA when POSTing to exempt path %s',
        async (path) => {
            // If this gate fired on /mfa/setup/* an admin without MFA
            // could NEVER enable MFA — the gate would block the very
            // request that would let them satisfy it. Pin the bypass.
            getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(true));

            const result = await runAuthenticate(makeReq({ method: 'POST', path }));

            expect(result.ok).toBe(true);
            // Exemption short-circuit fires BEFORE settings load.
            expect(getOrInitSettingsMock).not.toHaveBeenCalled();
        }
    );

    it('does NOT exempt `/mfa/disable` — disabling MFA must require having it', async () => {
        // Sanity: only setup paths are exempt. `/mfa/disable` is gated
        // because an admin trying to turn MFA OFF when the flag is ON
        // is doing the wrong thing — they should change the flag
        // first (which is itself gated).
        getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(true));
        userFindByIdMock.mockReturnValueOnce(userMfa(false));

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/mfa/disable' }));

        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({ code: ERROR_CODES.MFA_REQUIRED });
    });

    it.each(['/projects/abc/mfa/setup/init', '/users/me/mfa/setup/confirm'])(
        'does NOT exempt a hypothetical future route that ends in the exempt suffix (%s) — exact-match regression',
        async (path) => {
            // The previous `endsWith` matcher would have silently let
            // any route whose path ENDED in `/mfa/setup/init` bypass
            // the gate. Switching to exact `Set.has(path)` removes
            // that future-route trap. Pin it: a hypothetical
            // `/projects/:id/mfa/setup/init` (which doesn't exist
            // today, but might one day) must still be gated.
            getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(true));
            userFindByIdMock.mockReturnValueOnce(userMfa(false));

            const result = await runAuthenticate(makeReq({ method: 'POST', path }));

            expect(result.ok).toBe(false);
            expect(result.err).toMatchObject({ code: ERROR_CODES.MFA_REQUIRED });
        }
    );
});

// ─── Brick-safety regression ─────────────────────────────────────────────

describe('authenticate (brick-safety regression)', () => {
    it('a no-MFA admin canNOT toggle the flag back off via PATCH /settings', async () => {
        // Pin the design contract: the only safe way out of "flag on +
        // no MFA" is to enable MFA via the exempt setup paths. PATCH
        // /settings is itself gated, so an admin cannot accidentally
        // turn the flag on AND off again from a no-MFA session.
        getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(true));
        userFindByIdMock.mockReturnValueOnce(userMfa(false));

        const result = await runAuthenticate(makeReq({ method: 'PATCH', path: '/settings' }));

        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({ code: ERROR_CODES.MFA_REQUIRED });
    });
});

// ─── T1 — Status check (deactivate-but-token-still-valid) ────────────────

describe('authenticate (T1 — user status gate)', () => {
    it('rejects a deactivated user with 403 ACCOUNT_DEACTIVATED even when their JWT is still valid', async () => {
        // The headline T1 case: an admin deactivates a user; refresh
        // tokens are revoked but the access token (8h TTL) is still
        // signed. Without T1, that user could keep mutating data for
        // hours. With T1, every authenticated request reads the
        // status and refuses if it isn't `active`.
        userFindByIdMock.mockReturnValueOnce(userMfa(false, 'deactivated'));

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/users' }));

        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({
            statusCode: 403,
            code: ERROR_CODES.ACCOUNT_DEACTIVATED,
        });
    });

    it('the status check runs BEFORE the MFA gate (settings never read for a deactivated user)', async () => {
        // Ordering matters: a deactivated user should fail fast,
        // without burning the settings round-trip.
        userFindByIdMock.mockReturnValueOnce(userMfa(true, 'deactivated'));

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/users' }));

        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({ code: ERROR_CODES.ACCOUNT_DEACTIVATED });
        expect(getOrInitSettingsMock).not.toHaveBeenCalled();
    });

    it('reads status + mfa_enabled + company_id in ONE projection (cost-coalesced)', async () => {
        // The T1 status check, the admin-MFA gate, and the client-side
        // company scope all share this one row; we pin the projection so
        // no slot is dropped when any of the three is touched, and so a
        // regression that fetches the FULL user doc (PII bloat / perf)
        // is caught here rather than by someone reading logs later.
        //
        // `client_profile.company_id` is a single scalar, added because a
        // `client`'s project visibility is company-scoped and sourcing it
        // from the JWT would go stale on reassignment (no token-version
        // mechanism exists). It rides along on a read that already happens
        // on every authenticated request — zero extra round-trips.
        userFindByIdMock.mockReturnValueOnce(userMfa(false, 'active'));

        await runAuthenticate(makeReq({ method: 'POST', path: '/users' }));

        expect(userMfaSelectArgs).toEqual(['status mfa_enabled client_profile.company_id']);
    });
});

// ─── Step 47: requirePermission ──────────────────────────────────────────
//
// `requirePermission(...perms)` is the new RBAC gate. It accepts a caller
// when EITHER the wildcard `system.admin` permission is held, OR any of
// the requested permissions is held, OR the legacy `role: 'admin'` claim
// is present (back-compat for tokens issued before the Step-47 deploy).
// It also throws at factory time on an empty arg list so a typo can't
// silently allow everyone.

import { PERMISSIONS } from '../constants/permissions.js';
import { SYSTEM_ROLE_KEYS } from '../constants/role-keys.js';

interface MwReqLike {
    user?: {
        user_id: string;
        role: string;
        role_keys?: string[];
        permissions?: string[];
    };
}

const runMiddleware = (
    mw: (req: never, res: never, next: (err?: unknown) => void) => unknown,
    req: MwReqLike
): { ok: boolean; err?: unknown } => {
    let captured: { ok: boolean; err?: unknown } = { ok: false };
    const next = (err?: unknown): void => {
        captured = { ok: !err, err };
    };
    try {
        mw(req as never, {} as never, next);
    } catch (err) {
        captured = { ok: false, err };
    }
    return captured;
};

describe('requirePermission', () => {
    it('throws at factory time when called with no permissions (caller bug — fail loud)', () => {
        expect(() => middleware.requirePermission()).toThrow(/no permissions/i);
    });

    it('401s when there is no req.user (auth middleware should have already run)', () => {
        const mw = middleware.requirePermission(PERMISSIONS.PROJECT_WRITE);
        const result = runMiddleware(mw, {});
        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({ statusCode: 401 });
    });

    it('allows the caller when their permissions include the requested one', () => {
        const mw = middleware.requirePermission(PERMISSIONS.PROJECT_WRITE);
        const result = runMiddleware(mw, {
            user: {
                user_id: employeeId.toString(),
                role: ROLES.MANAGER,
                role_keys: [SYSTEM_ROLE_KEYS.MANAGER],
                permissions: [PERMISSIONS.PROJECT_WRITE, PERMISSIONS.SPRINT_WRITE],
            },
        });
        expect(result.ok).toBe(true);
    });

    it('allows when ANY of the requested permissions is held (OR semantics)', () => {
        const mw = middleware.requirePermission(PERMISSIONS.PROJECT_WRITE, PERMISSIONS.PROJECT_ARCHIVE);
        const result = runMiddleware(mw, {
            user: {
                user_id: employeeId.toString(),
                role: ROLES.TEAM_LEAD,
                role_keys: [SYSTEM_ROLE_KEYS.TEAM_LEAD],
                // Holds only the second of the two — should still pass.
                permissions: [PERMISSIONS.PROJECT_ARCHIVE],
            },
        });
        expect(result.ok).toBe(true);
    });

    it('forbids the caller when none of the requested permissions are held', () => {
        const mw = middleware.requirePermission(PERMISSIONS.BILLING_RATE_WRITE);
        const result = runMiddleware(mw, {
            user: {
                user_id: employeeId.toString(),
                role: ROLES.EMPLOYEE,
                role_keys: [SYSTEM_ROLE_KEYS.EMPLOYEE],
                permissions: [PERMISSIONS.PROJECT_READ, PERMISSIONS.TASK_READ],
            },
        });
        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({ statusCode: 403 });
    });

    it('admin wildcard (system.admin) passes any requirePermission gate', () => {
        // Admin holds only `system.admin` in storage; the gate must
        // recognise it as a universal pass — otherwise admin would
        // silently 403 on every other gate.
        const mw = middleware.requirePermission(PERMISSIONS.BILLING_RATE_WRITE);
        const result = runMiddleware(mw, {
            user: {
                user_id: adminId.toString(),
                role: ROLES.ADMIN,
                role_keys: [SYSTEM_ROLE_KEYS.ADMIN],
                permissions: [PERMISSIONS.SYSTEM_ADMIN],
            },
        });
        expect(result.ok).toBe(true);
    });

    it('legacy admin token without role_keys / permissions still passes (Phase B compat)', () => {
        // Tokens issued BEFORE the Step-47 deploy don't carry the new
        // claims — the legacy `role: 'admin'` field alone must still
        // be honoured during the migration window. Otherwise every
        // admin in flight would 403 on the first permission-gated
        // route after deploy, even if they have a fresh JWT.
        const mw = middleware.requirePermission(PERMISSIONS.PROJECT_WRITE);
        const result = runMiddleware(mw, {
            user: { user_id: adminId.toString(), role: ROLES.ADMIN },
        });
        expect(result.ok).toBe(true);
    });

    it('legacy non-admin token without permissions 403s (forces re-login on permission routes)', () => {
        // Mirror image of the above: a legacy employee/manager token
        // without `permissions` must NOT fall through. The 403 forces
        // re-login, which mints a fresh JWT with populated permissions.
        const mw = middleware.requirePermission(PERMISSIONS.PROJECT_WRITE);
        const result = runMiddleware(mw, {
            user: { user_id: employeeId.toString(), role: ROLES.EMPLOYEE },
        });
        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({ statusCode: 403 });
    });
});

// Step 47 Phase B has dropped the `authorize(...)` compat shim. All
// route gates now use `requirePermission(...)` exclusively.

// ─── Company scope for client-side roles ─────────────────────────────────
//
// `req.caller_company_id` is the security boundary for the `client` role:
// their project visibility is company-scoped, so if this silently fails to
// land, the filter degrades. It is sourced from the DB row rather than the
// JWT on purpose — see the note on the Request augmentation.

describe('authenticate (company scope)', () => {
    const companyId = new Types.ObjectId();

    /** findById chain resolving a client-side user carrying a company. */
    const userWithCompany = () => ({
        select: (arg: string) => {
            userMfaSelectArgs.push(arg);
            return {
                lean: () =>
                    Promise.resolve({
                        status: 'active',
                        mfa_enabled: false,
                        client_profile: { company_id: companyId },
                    }),
            };
        },
    });

    it('sets caller_company_id from the user row', async () => {
        userFindByIdMock.mockReturnValueOnce(userWithCompany());
        const req = makeReq({ method: 'GET', path: '/projects' });

        const result = await runAuthenticate(req);

        expect(result.ok).toBe(true);
        expect((req as { caller_company_id?: Types.ObjectId }).caller_company_id).toEqual(companyId);
    });

    it('leaves caller_company_id undefined for a staff user', async () => {
        // Default mock has no client_profile — the staff case.
        const req = makeReq({ method: 'GET', path: '/projects' });

        const result = await runAuthenticate(req);

        expect(result.ok).toBe(true);
        expect((req as { caller_company_id?: Types.ObjectId }).caller_company_id).toBeUndefined();
    });

    it('ignores a company_id claimed by the JWT', async () => {
        // Only the DB read may set company scope. A token claiming one —
        // forged, or merely stale after a reassignment — must not grant it.
        const forged = new Types.ObjectId();
        verifyAccessTokenMock.mockReturnValueOnce({
            user_id: adminId.toString(),
            role: ROLES.CLIENT,
            client_profile: { company_id: forged },
        });
        const req = makeReq({ method: 'GET', path: '/projects' });

        await runAuthenticate(req);

        expect((req as { caller_company_id?: Types.ObjectId }).caller_company_id).toBeUndefined();
    });
});

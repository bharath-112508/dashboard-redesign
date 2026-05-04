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
const userMfaSelectArgs: string[] = [];
const userMfa = (mfa_enabled: boolean) => ({
    select: (arg: string) => {
        userMfaSelectArgs.push(arg);
        return { lean: () => Promise.resolve({ mfa_enabled }) };
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
        expect(userFindByIdMock).not.toHaveBeenCalled();
    });

    it('reads settings ONCE for an admin write but no-ops when require_mfa_for_admins is false', async () => {
        getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(false));

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/users' }));

        expect(result.ok).toBe(true);
        expect(getOrInitSettingsMock).toHaveBeenCalledTimes(1);
        // Flag is false → user lookup never fires.
        expect(userFindByIdMock).not.toHaveBeenCalled();
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
        // user document. A regression that switches to .select('+something')
        // or drops the projection would balloon the per-write payload.
        expect(userMfaSelectArgs).toEqual(['mfa_enabled']);
    });

    it('returns 403 MFA_REQUIRED when the user row was deleted between JWT issue and gate evaluation', async () => {
        // Edge case: admin's JWT is still valid (8h TTL) but the user
        // row was hard-deleted. Optional-chaining on `userRow?.mfa_enabled`
        // collapses null to "not enabled" → gate fires. The alternative
        // (passing through because the user doesn't exist) would let a
        // tombstoned admin's JWT continue to mutate state — much worse
        // than a 403.
        getOrInitSettingsMock.mockResolvedValueOnce(settingsWithFlag(true));
        userFindByIdMock.mockReturnValueOnce(userMfaDeleted());

        const result = await runAuthenticate(makeReq({ method: 'POST', path: '/users' }));

        expect(result.ok).toBe(false);
        expect(result.err).toMatchObject({ code: ERROR_CODES.MFA_REQUIRED });
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
            expect(userFindByIdMock).not.toHaveBeenCalled();
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

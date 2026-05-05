import { describe, expect, it } from 'vitest';

import { isAdminLike } from './role-check.js';

/**
 * Pins the contract for `isAdminLike` (BACKEND_AUDIT.md R4) — both
 * signals (legacy `role`, Step-47 `role_keys`) recognise admin, and
 * a non-admin in either is rejected. Mirrors `auth.middleware`'s
 * private `isCallerAdmin` so the route gate and service gate agree.
 */

describe('isAdminLike', () => {
    it('recognises legacy role === "admin"', () => {
        expect(isAdminLike({ role: 'admin' })).toBe(true);
    });

    it('recognises role_keys.includes("admin") even when legacy role is something else', () => {
        // The headline R4 case: a multi-role admin whose legacy `role`
        // cache is `'manager'` (because manager appears first in the
        // role_ids array) is still recognised as admin via role_keys.
        expect(isAdminLike({ role: 'manager', role_keys: ['manager', 'admin'] })).toBe(true);
    });

    it('returns false when neither signal names admin', () => {
        expect(isAdminLike({ role: 'manager', role_keys: ['manager'] })).toBe(false);
        expect(isAdminLike({ role: 'employee' })).toBe(false);
        expect(isAdminLike({})).toBe(false);
    });

    it('handles missing role_keys gracefully (pre-Step-47 callers)', () => {
        // Callers that don't yet thread `role_keys` through fall back
        // to legacy `role` only — exactly matching pre-R4 behaviour.
        expect(isAdminLike({ role: 'admin' })).toBe(true);
        expect(isAdminLike({ role: 'manager' })).toBe(false);
    });

    it('handles role being null / undefined', () => {
        expect(isAdminLike({ role: null })).toBe(false);
        expect(isAdminLike({ role: undefined })).toBe(false);
        expect(isAdminLike({ role_keys: ['admin'] })).toBe(true);
    });

    it('treats empty role_keys as no signal', () => {
        expect(isAdminLike({ role: 'employee', role_keys: [] })).toBe(false);
    });
});

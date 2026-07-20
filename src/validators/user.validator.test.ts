import { describe, expect, it } from 'vitest';

import { createUserBodySchema, updateUserBodySchema, listUsersQuerySchema } from './user.validator.js';

/**
 * BUG-044 — phone field accepts only valid international (E.164) numbers,
 * validated against libphonenumber-js country rules. Empty / omitted is OK
 * (the field is optional on both create and update).
 *
 * These tests focus on the phone refinement; the broader role/profile
 * cross-checks are covered by integration smoke tests.
 */

const baseInternalProfile = {
    employee_id: 'EMP-1',
    job_title: 'Engineer',
    department: 'Eng',
    date_of_joining: '2024-01-15',
};

const baseCreatePayload = {
    email: 'jane@example.com',
    full_name: 'Jane',
    role: 'employee' as const,
    initial_password: 'Pa$$word12',
    internal_profile: baseInternalProfile,
};

describe('createUserBodySchema — BUG-044 phone validation', () => {
    it('accepts a valid US number in E.164', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            phone: '+14155552671',
        });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.phone).toBe('+14155552671');
    });

    it('accepts a valid Indian number in E.164', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            phone: '+919876543210',
        });
        expect(r.success).toBe(true);
    });

    it('accepts and normalises a number with formatting (parens/dashes/spaces)', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            phone: '+1 (415) 555-2671',
        });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.phone).toBe('+14155552671');
    });

    it('rejects a number that is too short for its country', () => {
        // US needs 10 national digits after +1.
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            phone: '+15551234',
        });
        expect(r.success).toBe(false);
    });

    it('rejects a number that is too long', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            phone: '+141555526711234567',
        });
        expect(r.success).toBe(false);
    });

    it('rejects a number missing the country code prefix', () => {
        // libphonenumber-js will fail to parse without a + or a defaultCountry.
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            phone: '4155552671',
        });
        expect(r.success).toBe(false);
    });

    it('rejects non-digit garbage', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            phone: '+1abcdefghij',
        });
        expect(r.success).toBe(false);
    });

    it('accepts omitted phone', () => {
        const r = createUserBodySchema.safeParse(baseCreatePayload);
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.phone).toBeUndefined();
    });

    it('treats empty-string phone as not supplied', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            phone: '',
        });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.phone).toBeUndefined();
    });
});

describe('updateUserBodySchema — BUG-044 phone validation', () => {
    it('accepts a valid E.164 phone', () => {
        const r = updateUserBodySchema.safeParse({ phone: '+919876543210' });
        expect(r.success).toBe(true);
    });

    it('rejects an invalid phone on patch', () => {
        const r = updateUserBodySchema.safeParse({ phone: '+15551234' });
        expect(r.success).toBe(false);
    });

    it('accepts empty-string phone on patch (no change after refinement → omitted)', () => {
        // Empty string is the FE "user cleared the field" representation; the
        // refinement no-ops and the field falls through as undefined. The
        // partial-patch refine still passes because the patch carries this
        // field name.
        const r = updateUserBodySchema.safeParse({ phone: '' });
        expect(r.success).toBe(true);
    });
});

describe('createUserBodySchema — BUG-045 timezone validation', () => {
    it('accepts a supported IANA timezone', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            timezone: 'Asia/Kolkata',
        });
        expect(r.success).toBe(true);
    });

    it('accepts UTC', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            timezone: 'UTC',
        });
        expect(r.success).toBe(true);
    });

    it('rejects an unrecognised timezone string', () => {
        // 'IST' is a common typo — it's an abbreviation, not an IANA zone.
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            timezone: 'IST',
        });
        expect(r.success).toBe(false);
    });

    it('rejects free-text garbage like "India"', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            timezone: 'India',
        });
        expect(r.success).toBe(false);
    });

    it('treats empty-string timezone as not supplied', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            timezone: '',
        });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.timezone).toBeUndefined();
    });
});

describe('updateUserBodySchema — BUG-045 timezone validation', () => {
    it('accepts a supported zone on patch', () => {
        const r = updateUserBodySchema.safeParse({ timezone: 'America/New_York' });
        expect(r.success).toBe(true);
    });

    it('rejects an unsupported zone on patch', () => {
        const r = updateUserBodySchema.safeParse({ timezone: 'Pluto/Equator' });
        expect(r.success).toBe(false);
    });
});

// ─── exclude_role — multi-role exclusion ─────────────────────────────────
//
// This was a SINGLE role, which is why the staff directory sent
// `exclude_role=client` and silently kept listing `representative`s among
// the internal staff: there was no way to name the second client-side role.

describe('listUsersQuerySchema — exclude_role', () => {
    it('accepts a comma-separated list', () => {
        const parsed = listUsersQuerySchema.parse({ exclude_role: 'client,representative' });
        expect(parsed.exclude_role).toEqual(['client', 'representative']);
    });

    it('still accepts a bare single value, so existing callers keep working', () => {
        const parsed = listUsersQuerySchema.parse({ exclude_role: 'client' });
        expect(parsed.exclude_role).toEqual(['client']);
    });

    it('tolerates whitespace around the separator', () => {
        const parsed = listUsersQuerySchema.parse({ exclude_role: 'client , representative' });
        expect(parsed.exclude_role).toEqual(['client', 'representative']);
    });

    it('rejects an unknown role rather than silently ignoring it', () => {
        // Silently dropping it would mean a typo'd exclusion quietly widens
        // the result set.
        expect(() => listUsersQuerySchema.parse({ exclude_role: 'client,wizard' })).toThrow();
    });

    it('still refuses role + exclude_role together', () => {
        expect(() => listUsersQuerySchema.parse({ role: 'employee', exclude_role: 'client' })).toThrow();
    });
});

// The write body must NOT gain `representative`: that role is created via
// POST /companies/:id/representatives, which derives role + company
// server-side. A second path through POST /users would skip those guards.
describe('createUserBodySchema — representative is not creatable here', () => {
    it('rejects role=representative on the generic user-create body', () => {
        expect(() =>
            createUserBodySchema.parse({
                email: 'x@y.io',
                full_name: 'X',
                role: 'representative',
                initial_password: 'Vilje@1234',
            })
        ).toThrow();
    });
});

import { describe, expect, it } from 'vitest';

import {
    createUserBodySchema,
    updateUserBodySchema,
    listUsersQuerySchema,
    userPhotosQuerySchema,
} from './user.validator.js';

/**
 * BUG-044 — phone field accepts only valid international (E.164) numbers,
 * validated against libphonenumber-js country rules. Empty / omitted is OK
 * (the field is optional on both create and update).
 *
 * These tests focus on the phone refinement; the broader role/profile
 * cross-checks are covered by integration smoke tests.
 */

const MANAGER_ID = 'a'.repeat(24);

const baseInternalProfile = {
    employee_id: 'EMP-1',
    job_title: 'Engineer',
    department: 'Eng',
    date_of_joining: '2024-01-15',
    // Required for every non-admin role — see the reporting-manager suite at
    // the bottom of this file for why.
    reporting_manager_id: MANAGER_ID,
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

    it('treats empty-string phone as "no phone" on create', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            phone: '',
        });
        expect(r.success).toBe(true);
        // `null` on create and absent mean the same thing — nobody to clear.
        if (r.success) expect(r.data.phone ?? undefined).toBeUndefined();
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

    /**
     * The three states have to stay distinct, because `updateUser` keys off
     * them: absent leaves the stored number alone, `null` removes it. They
     * used to collapse — '' became `undefined`, the patch looked like it never
     * mentioned phone, and clearing the field reported success while the old
     * number stayed. It then reappeared on the next refresh.
     */
    it('reads an empty-string phone as CLEAR, not as "not supplied"', () => {
        const r = updateUserBodySchema.safeParse({ phone: '' });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.phone).toBeNull();
    });

    it('reads an explicit null as CLEAR', () => {
        const r = updateUserBodySchema.safeParse({ phone: null });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.phone).toBeNull();
    });

    it('leaves phone untouched when the patch omits it', () => {
        const r = updateUserBodySchema.safeParse({ full_name: 'No phone here' });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.phone).toBeUndefined();
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

/**
 * A reporting manager is REQUIRED for every role except admin.
 *
 * `reporting-scope.service` narrows every team-facing surface — leave
 * approvals, team attendance, team timesheets, comp-off ledger, team leave
 * balances, the Slack App Home — to the reviewer's direct reports. Someone
 * created without a manager is therefore invisible to every reviewer except
 * an admin, on all of those screens at once, and nothing surfaces the
 * omission. It used to be optional and was routinely skipped.
 */
describe('createUserBodySchema — reporting manager', () => {
    const withProfile = (profile: Record<string, unknown>, role = 'employee') => ({
        ...baseCreatePayload,
        role,
        internal_profile: { ...baseInternalProfile, ...profile },
    });

    it.each([['employee'], ['team_lead'], ['manager']])('requires one for role=%s', (role) => {
        const r = createUserBodySchema.safeParse(withProfile({ reporting_manager_id: undefined }, role));
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.path.includes('reporting_manager_id'))).toBe(true);
        }
    });

    it('rejects an explicit null just as it rejects an omission', () => {
        // `null` is what the create form sent by default, so this is the shape
        // the gap actually arrived in.
        expect(createUserBodySchema.safeParse(withProfile({ reporting_manager_id: null })).success).toBe(false);
    });

    it('accepts one when supplied', () => {
        expect(createUserBodySchema.safeParse(withProfile({ reporting_manager_id: MANAGER_ID })).success).toBe(true);
    });

    // The admin is the ROOT of the reporting chain — requiring one there would
    // mean inventing a manager for the person at the top of the org.
    it('exempts admin', () => {
        const r = createUserBodySchema.safeParse(withProfile({ reporting_manager_id: undefined }, 'admin'));
        expect(r.success).toBe(true);
    });

    it('leaves PATCH untouched, so existing records without one stay editable', () => {
        // Everyone already created without a manager must still be able to have
        // their job title fixed; requiring it on PATCH would have locked them.
        const r = updateUserBodySchema.safeParse({ internal_profile: { job_title: 'Staff Engineer' } });
        expect(r.success).toBe(true);
    });
});

/**
 * The employment record is staff-only. A freelancer is engaged, not employed,
 * so they have no employee number, job title, department or joining date.
 *
 * 🔴 These tests send EMPTY STRINGS, not omitted keys — that distinction is
 * the whole bug. A form field the user left alone submits as `''`, and
 * `.min(1).optional()` rejects it, because `optional()` admits `undefined`
 * and nothing else. The first version of this feature was verified against
 * omitted keys, passed, and still returned "Too small: expected string to
 * have >=1 characters" to every real user of the form.
 */
describe('createUserBodySchema — freelancer employment record', () => {
    const blanks = { employee_id: '', job_title: '', department: '', date_of_joining: '' };

    it('accepts a freelancer whose employment fields are empty strings', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            internal_profile: { ...baseInternalProfile, ...blanks, employment_type: 'freelancer' },
        });
        expect(r.success).toBe(true);
    });

    it('normalises those blanks to absent rather than storing empty strings', () => {
        // `employee_id` carries a UNIQUE SPARSE index: sparse skips documents
        // missing the key, but an empty string is a value — so a second
        // freelancer stored with '' would collide on E11000.
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            internal_profile: { ...baseInternalProfile, ...blanks, employment_type: 'freelancer' },
        });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.internal_profile?.employee_id).toBeUndefined();
            expect(r.data.internal_profile?.job_title).toBeUndefined();
            expect(r.data.internal_profile?.department).toBeUndefined();
            expect(r.data.internal_profile?.date_of_joining).toBeUndefined();
        }
    });

    it('accepts a freelancer whose employment fields are omitted entirely', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            internal_profile: { reporting_manager_id: MANAGER_ID, employment_type: 'freelancer' },
        });
        expect(r.success).toBe(true);
    });

    it('still REFUSES staff sending the same empty strings', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            internal_profile: { ...baseInternalProfile, ...blanks, employment_type: 'staff' },
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            const fields = r.error.issues.map((i) => i.path.join('.'));
            expect(fields).toEqual(
                expect.arrayContaining([
                    'internal_profile.employee_id',
                    'internal_profile.job_title',
                    'internal_profile.department',
                    'internal_profile.date_of_joining',
                ])
            );
        }
    });

    it('defaults to staff, so an omitted employment_type still requires the record', () => {
        const r = createUserBodySchema.safeParse({
            ...baseCreatePayload,
            internal_profile: { ...baseInternalProfile, ...blanks },
        });
        expect(r.success).toBe(false);
    });
});

describe('userPhotosQuerySchema', () => {
    const id = 'a'.repeat(24);
    it('splits a comma list of ObjectIds', () => {
        expect(userPhotosQuerySchema.parse({ ids: `${id},${'b'.repeat(24)}` }).ids).toEqual([id, 'b'.repeat(24)]);
    });
    it('rejects a bad id and more than 200', () => {
        expect(userPhotosQuerySchema.safeParse({ ids: 'nope' }).success).toBe(false);
        expect(
            userPhotosQuerySchema.safeParse({
                ids: Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(24, '0')).join(','),
            }).success
        ).toBe(false);
    });
});

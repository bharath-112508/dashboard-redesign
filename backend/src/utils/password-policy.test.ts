import { describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * The password policy is configured in Settings → Security and enforced here.
 *
 * The bug these tests exist to prevent: the six `security.password_*` fields
 * were editable in the admin UI and read by nothing — the real rule was a
 * hardcoded regex. An admin could tighten the policy, watch it save, and be
 * wrong about their own security posture. So the load-bearing assertion in
 * this file is not "weak passwords are rejected" but **"changing the setting
 * changes what is rejected"**.
 *
 * `resolvePasswordPolicy` / `findPasswordViolations` are pure, so most of this
 * needs no mocking; only `assertPasswordPolicy` reads settings.
 */

const { getOrInitSettingsMock } = vi.hoisted(() => ({
    getOrInitSettingsMock: vi.fn(),
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: getOrInitSettingsMock,
}));

const {
    assertPasswordPolicy,
    describePasswordPolicy,
    findPasswordViolations,
    resolvePasswordPolicy,
    PASSWORD_POLICY_FALLBACK,
} = await import('./password-policy.js');

/** Point the settings singleton at a given `security` subdocument. */
const withSettings = (security: Record<string, unknown>): void => {
    getOrInitSettingsMock.mockResolvedValue({ security });
};

describe('resolvePasswordPolicy — settings win, defaults fill the gaps', () => {
    it('falls back to the built-in 10–12 + all-four-classes rule when unset', () => {
        expect(resolvePasswordPolicy(undefined)).toEqual(PASSWORD_POLICY_FALLBACK);
        expect(resolvePasswordPolicy(null)).toEqual(PASSWORD_POLICY_FALLBACK);
        expect(resolvePasswordPolicy({})).toEqual(PASSWORD_POLICY_FALLBACK);
    });

    it('takes each configured field over the default', () => {
        const policy = resolvePasswordPolicy({
            password_min_length: 14,
            password_max_length: 128,
            password_require_special: false,
        });
        expect(policy.min_length).toBe(14);
        expect(policy.max_length).toBe(128);
        expect(policy.require_special).toBe(false);
        // untouched fields still default to required
        expect(policy.require_upper).toBe(true);
    });

    it('does not treat a legitimately falsy setting as unset', () => {
        // `false ?? true` is false; `false || true` would be true — that second
        // form is the bug this pins. An admin turning a requirement OFF must
        // not have it silently turned back on by the fallback.
        expect(resolvePasswordPolicy({ password_require_number: false }).require_number).toBe(false);
    });
});

describe('findPasswordViolations', () => {
    const fallback = PASSWORD_POLICY_FALLBACK;

    it('accepts a password meeting every rule', () => {
        expect(findPasswordViolations('Aa1!aaaaaa', fallback)).toEqual([]);
        expect(findPasswordViolations('Aa1!aaaaaaaa', fallback)).toEqual([]); // 12, upper bound
    });

    it('reports every broken rule at once, not just the first', () => {
        // 3 chars, no upper, no digit, no special → 4 distinct problems.
        const problems = findPasswordViolations('abc', fallback);
        expect(problems).toHaveLength(4);
        expect(problems.join(' ')).toContain('at least 10 characters');
        expect(problems.join(' ')).toContain('an uppercase letter');
    });

    it('catches each category on its own', () => {
        expect(findPasswordViolations('Aa1!aaaaa', fallback)).toHaveLength(1); // 9 chars
        expect(findPasswordViolations('Aa1!aaaaaaaaa', fallback)).toHaveLength(1); // 13 chars
        expect(findPasswordViolations('aa1!aaaaaa', fallback)).toHaveLength(1); // no upper
        expect(findPasswordViolations('AA1!AAAAAA', fallback)).toHaveLength(1); // no lower
        expect(findPasswordViolations('Aa!aaaaaaa', fallback)).toHaveLength(1); // no digit
        expect(findPasswordViolations('Aa1aaaaaaa', fallback)).toHaveLength(1); // no special
    });

    it('stops requiring a character class the policy has turned off', () => {
        const noSpecial = { ...fallback, require_special: false };
        expect(findPasswordViolations('Aa1aaaaaaa', noSpecial)).toEqual([]);
    });
});

describe('assertPasswordPolicy — reads the CONFIGURED policy, not a constant', () => {
    const expectViolation = async (input: string): Promise<void> => {
        await expect(assertPasswordPolicy(input)).rejects.toMatchObject({
            statusCode: 422,
            code: ERROR_CODES.PASSWORD_POLICY_VIOLATION,
        });
    };

    it('applies the built-in default when settings are unseeded', async () => {
        withSettings({});
        await expect(assertPasswordPolicy('Aa1!aaaaaa')).resolves.toBeUndefined();
        await expectViolation('Aa1!aaaaa'); // 9 chars
        await expectViolation('');
    });

    it('REJECTS a password the old hardcoded rule accepted, once min_length is raised', async () => {
        // The regression that matters: 'Aa1!aaaaaa' passed the old `{10,12}`
        // regex. An admin raising the minimum to 14 must make it fail.
        withSettings({ password_min_length: 14, password_max_length: 64 });
        await expectViolation('Aa1!aaaaaa');
        await expect(assertPasswordPolicy('Aa1!aaaaaaaaaa')).resolves.toBeUndefined();
    });

    it('ACCEPTS a password the old hardcoded rule rejected, once max_length is raised', async () => {
        // The 12-char ceiling blocked password managers outright. Raising it
        // must actually let a long generated password through.
        const generated = 'Xq7#mVt2!pLw9$zRk4eB';
        withSettings({});
        await expectViolation(generated); // 20 chars — over the default ceiling
        withSettings({ password_max_length: 128 });
        await expect(assertPasswordPolicy(generated)).resolves.toBeUndefined();
    });

    it('honours a character class being switched off', async () => {
        withSettings({ password_require_special: false, password_require_upper: false });
        await expect(assertPasswordPolicy('aa1aaaaaaa')).resolves.toBeUndefined();
    });

    it('names every broken rule in one message', async () => {
        withSettings({});
        await expect(assertPasswordPolicy('abc')).rejects.toThrow(/at least 10 characters.*uppercase.*number.*special/);
    });
});

describe('describePasswordPolicy', () => {
    it('summarises the configured range and classes', () => {
        expect(describePasswordPolicy(PASSWORD_POLICY_FALLBACK)).toBe(
            '10–12 characters, and include an uppercase letter, a lowercase letter, a number, a special character'
        );
    });

    it('drops the class clause entirely when none are required', () => {
        expect(
            describePasswordPolicy({
                min_length: 8,
                max_length: 64,
                require_upper: false,
                require_lower: false,
                require_number: false,
                require_special: false,
            })
        ).toBe('8–64 characters');
    });
});

import { describe, expect, it } from 'vitest';

import { assertPasswordPolicy } from './password-policy.js';
import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * `assertPasswordPolicy` enforces plan §7.2 at the service layer for
 * password fields that Zod only structurally validates (e.g.
 * `POST /users { initial_password }` — Zod sees a string, this helper
 * rejects weak strings).
 *
 * Policy: length 10–12, must contain at least one of each:
 *   upper, lower, digit, special.
 *
 * What we lock in:
 *   1. Each rejected category throws `422 PASSWORD_POLICY_VIOLATION`.
 *   2. Valid passwords return undefined (no throw).
 *   3. The error code is canonical (the FE keys off it for the
 *      "password too weak" toast).
 */

describe('assertPasswordPolicy — accepts policy-compliant passwords', () => {
    it('accepts a 10-char password meeting all four categories', () => {
        // Aa1!aaaaaa — 10 chars, upper + lower + digit + special.
        expect(() => assertPasswordPolicy('Aa1!aaaaaa')).not.toThrow();
    });

    it('accepts a 12-char password meeting all four categories (upper bound)', () => {
        expect(() => assertPasswordPolicy('Aa1!aaaaaaaa')).not.toThrow();
    });
});

describe('assertPasswordPolicy — rejects with 422 PASSWORD_POLICY_VIOLATION', () => {
    const expectViolation = (input: string): void => {
        try {
            assertPasswordPolicy(input);
            throw new Error(`expected throw for input "${input}"`);
        } catch (err) {
            expect(err).toMatchObject({
                statusCode: 422,
                code: ERROR_CODES.PASSWORD_POLICY_VIOLATION,
            });
        }
    };

    it('rejects too-short passwords (< 10 chars)', () => {
        expectViolation('Aa1!aaaaa'); // 9 chars
        expectViolation('A');
    });

    it('rejects too-long passwords (> 12 chars)', () => {
        expectViolation('Aa1!aaaaaaaaa'); // 13 chars
    });

    it('rejects passwords missing an uppercase letter', () => {
        expectViolation('aa1!aaaaaa');
    });

    it('rejects passwords missing a lowercase letter', () => {
        expectViolation('AA1!AAAAAA');
    });

    it('rejects passwords missing a digit', () => {
        expectViolation('Aa!aaaaaaa');
    });

    it('rejects passwords missing a special character', () => {
        expectViolation('Aa1aaaaaaa');
    });

    it('rejects the empty string', () => {
        expectViolation('');
    });
});

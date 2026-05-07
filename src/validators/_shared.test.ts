import { describe, expect, it } from 'vitest';

import { booleanish } from './_shared.js';

/**
 * Contract test for the `booleanish` Zod helper (H4).
 *
 * `booleanish` exists because `z.coerce.boolean()` is `Boolean(value)`
 * and treats ANY non-empty string as truthy — so a query param
 * `?active_only=false` arrives as the string `"false"` and gets
 * silently flipped to `true`. The `booleanish` helper accepts only
 * the literal strings `"true"` / `"false"` or a real boolean and
 * fails-loud on anything else.
 *
 * If anyone "improves" the helper to accept `"1"`/`"yes"`/etc. or
 * loosens the case-sensitivity, this contract drifts and the bugs
 * H4 fixed return for new fields. Pin the contract here.
 */

describe('booleanish helper', () => {
    describe('accepts the canonical inputs', () => {
        it('accepts the literal string "true" → true', () => {
            expect(booleanish.parse('true')).toBe(true);
        });

        it('accepts the literal string "false" → false', () => {
            expect(booleanish.parse('false')).toBe(false);
        });

        it('accepts a real boolean true → true', () => {
            expect(booleanish.parse(true)).toBe(true);
        });

        it('accepts a real boolean false → false', () => {
            expect(booleanish.parse(false)).toBe(false);
        });
    });

    describe('rejects everything else (fail-loud, no silent guesses)', () => {
        it('rejects "1"', () => {
            expect(() => booleanish.parse('1')).toThrow();
        });

        it('rejects "0"', () => {
            expect(() => booleanish.parse('0')).toThrow();
        });

        it('rejects "yes"', () => {
            expect(() => booleanish.parse('yes')).toThrow();
        });

        it('rejects "no"', () => {
            expect(() => booleanish.parse('no')).toThrow();
        });

        it('rejects "FALSE" (case-sensitive)', () => {
            // Case-sensitive on purpose — we don't want the BE to be
            // lenient about query-string casing because that diverges
            // from the FE's `String(boolean)` convention which produces
            // the canonical lowercase form.
            expect(() => booleanish.parse('FALSE')).toThrow();
        });

        it('rejects "True" (mixed case)', () => {
            expect(() => booleanish.parse('True')).toThrow();
        });

        it('rejects empty string', () => {
            expect(() => booleanish.parse('')).toThrow();
        });

        it('rejects numbers', () => {
            expect(() => booleanish.parse(0)).toThrow();
            expect(() => booleanish.parse(1)).toThrow();
        });

        it('rejects null', () => {
            expect(() => booleanish.parse(null)).toThrow();
        });

        it('rejects undefined when not wrapped in `.optional()`', () => {
            // Direct .parse(undefined) on a non-optional union should fail.
            // (Consumers chain `.optional().default(false)` to handle the
            // omitted-param case.)
            expect(() => booleanish.parse(undefined)).toThrow();
        });
    });

    describe('chaining with .optional().default(false) (the actual usage shape)', () => {
        const optional = booleanish.optional().default(false);

        it('returns the default when the field is undefined', () => {
            expect(optional.parse(undefined)).toBe(false);
        });

        it('still parses canonical inputs through the chain', () => {
            expect(optional.parse('true')).toBe(true);
            expect(optional.parse('false')).toBe(false);
            expect(optional.parse(true)).toBe(true);
        });

        it('still rejects non-canonical inputs through the chain', () => {
            expect(() => optional.parse('1')).toThrow();
            expect(() => optional.parse('FALSE')).toThrow();
        });
    });
});

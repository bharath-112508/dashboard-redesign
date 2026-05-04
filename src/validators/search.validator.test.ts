import { describe, expect, it } from 'vitest';

import { searchQuerySchema } from './search.validator.js';

/**
 * Validator tests for `GET /search` (Step 32).
 *
 * The query schema does the heavy lifting for the typeahead UI:
 *   - Rejects too-short queries (< 2 chars) so single-letter
 *     keystrokes don't fire a request.
 *   - Splits / dedupes / validates the comma-separated `types=` list
 *     into a typed array.
 *   - Caps `limit` at 50.
 */

describe('searchQuerySchema', () => {
    it('accepts a minimal query (q only) with default limit', () => {
        const parsed = searchQuerySchema.parse({ q: 'login' });
        expect(parsed.q).toBe('login');
        expect(parsed.limit).toBe(10);
        expect(parsed.types).toBeUndefined();
    });

    it('rejects a single-character q', () => {
        const result = searchQuerySchema.safeParse({ q: 'a' });
        expect(result.success).toBe(false);
    });

    it('trims the q before measuring length', () => {
        const result = searchQuerySchema.safeParse({ q: '  a  ' });
        // After trim, q='a' (1 char) — below the 2-char floor.
        expect(result.success).toBe(false);
    });

    it('accepts a 2-char q', () => {
        const parsed = searchQuerySchema.parse({ q: 'qa' });
        expect(parsed.q).toBe('qa');
    });

    it('parses types= into a deduplicated array', () => {
        const parsed = searchQuerySchema.parse({
            q: 'login',
            types: 'users,projects,users',
        });
        expect(parsed.types).toEqual(['users', 'projects']);
    });

    it('rejects unknown type values', () => {
        const result = searchQuerySchema.safeParse({
            q: 'login',
            types: 'users,bogus',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].message).toMatch(/Unknown type "bogus"/);
        }
    });

    it('rejects an empty types= list', () => {
        const result = searchQuerySchema.safeParse({ q: 'login', types: ',,' });
        expect(result.success).toBe(false);
    });

    it('caps limit at 50 — 51 is rejected', () => {
        expect(searchQuerySchema.safeParse({ q: 'login', limit: 51 }).success).toBe(false);
    });

    it('coerces limit from a string (URL query strings are always strings)', () => {
        const parsed = searchQuerySchema.parse({ q: 'login', limit: '25' });
        expect(parsed.limit).toBe(25);
    });

    it('rejects extra top-level keys via .strict()', () => {
        const result = searchQuerySchema.safeParse({ q: 'login', sort: 'name' });
        expect(result.success).toBe(false);
    });

    it('caps q length at 100 chars', () => {
        const long = 'a'.repeat(101);
        expect(searchQuerySchema.safeParse({ q: long }).success).toBe(false);
    });
});

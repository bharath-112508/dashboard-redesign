import { describe, expect, it } from 'vitest';

import { listAuditArchivesQuerySchema } from './audit-archive.validator.js';

/**
 * Validator tests for `GET /audit-archives` (Phase 4 Step 39).
 */

describe('listAuditArchivesQuerySchema', () => {
    it('accepts an empty query (defaults page=1, limit=20)', () => {
        const parsed = listAuditArchivesQuerySchema.parse({});
        expect(parsed.page).toBe(1);
        expect(parsed.limit).toBe(20);
    });

    it('rejects from_date > to_date with the issue path on to_date', () => {
        const result = listAuditArchivesQuerySchema.safeParse({
            from_date: '2026-01-31',
            to_date: '2026-01-01',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('to_date');
        }
    });

    it('rejects malformed dates (not YYYY-MM-DD)', () => {
        const result = listAuditArchivesQuerySchema.safeParse({ from_date: '01/01/2026' });
        expect(result.success).toBe(false);
    });

    it('caps limit at 100', () => {
        expect(listAuditArchivesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });

    it('rejects extra top-level keys via .strict()', () => {
        expect(listAuditArchivesQuerySchema.safeParse({ malicious: 'before' }).success).toBe(false);
    });
});

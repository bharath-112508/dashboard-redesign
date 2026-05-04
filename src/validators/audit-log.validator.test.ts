import { describe, expect, it } from 'vitest';

import { listAuditLogsQuerySchema } from './audit-log.validator.js';

/**
 * Validator-refine tests (Step 31).
 *
 * The two cross-field refines on the list-query schema enforce on-index
 * lookups + sane date ranges. Their behavior is the contract surface for
 * the FE filter UI.
 */

describe('listAuditLogsQuerySchema', () => {
    it('accepts a query with no filters (defaults page=1, limit=20)', () => {
        const parsed = listAuditLogsQuerySchema.parse({});
        expect(parsed.page).toBe(1);
        expect(parsed.limit).toBe(20);
    });

    it('rejects from_date > to_date with a clear field path', () => {
        const result = listAuditLogsQuerySchema.safeParse({
            from_date: '2026-04-30',
            to_date: '2026-04-01',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('to_date');
        }
    });

    it('rejects target_id without target_kind (would skip the composite index)', () => {
        const result = listAuditLogsQuerySchema.safeParse({
            target_id: 'a'.repeat(24),
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('target_kind');
        }
    });

    it('accepts target_kind alone (kind-only is on the composite index prefix)', () => {
        const result = listAuditLogsQuerySchema.safeParse({ target_kind: 'user' });
        expect(result.success).toBe(true);
    });

    it('caps limit at 100 — 101 is rejected', () => {
        const result = listAuditLogsQuerySchema.safeParse({ limit: 101 });
        expect(result.success).toBe(false);
    });

    it('rejects extra top-level keys via .strict()', () => {
        const result = listAuditLogsQuerySchema.safeParse({ malicious_filter: 'before' });
        expect(result.success).toBe(false);
    });
});

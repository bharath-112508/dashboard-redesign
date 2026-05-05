import { describe, expect, it } from 'vitest';

import { timelineQuerySchema } from './timeline.validator.js';

/**
 * Validator tests for `GET /projects/:id/timeline` (Phase 4 Step 41).
 */

const ID = 'a'.repeat(24);

describe('timelineQuerySchema', () => {
    const baseQuery = (overrides: Record<string, unknown> = {}) => ({
        from_date: '2026-01-01',
        to_date: '2026-03-31',
        ...overrides,
    });

    it('accepts a minimal valid window', () => {
        const parsed = timelineQuerySchema.parse(baseQuery());
        expect(parsed.from_date).toBe('2026-01-01');
        expect(parsed.include_completed).toBe(false); // default
    });

    it('rejects from_date > to_date', () => {
        const result = timelineQuerySchema.safeParse(baseQuery({ from_date: '2026-12-31', to_date: '2026-01-01' }));
        expect(result.success).toBe(false);
    });

    it('rejects a window > 365 days (the platform-wide range cap)', () => {
        const result = timelineQuerySchema.safeParse({ from_date: '2026-01-01', to_date: '2027-12-31' });
        expect(result.success).toBe(false);
    });

    it('coerces include_completed from "true"/"false" strings (URL query)', () => {
        const onParsed = timelineQuerySchema.parse(baseQuery({ include_completed: 'true' }));
        expect(onParsed.include_completed).toBe(true);
        const offParsed = timelineQuerySchema.parse(baseQuery({ include_completed: 'false' }));
        expect(offParsed.include_completed).toBe(false);
    });

    it('accepts optional sprint_id + story_id', () => {
        const parsed = timelineQuerySchema.parse(baseQuery({ sprint_id: ID, story_id: ID }));
        expect(parsed.sprint_id).toBe(ID);
        expect(parsed.story_id).toBe(ID);
    });

    it('rejects malformed sprint_id', () => {
        expect(timelineQuerySchema.safeParse(baseQuery({ sprint_id: 'not-an-id' })).success).toBe(false);
    });

    it('rejects extra top-level keys via .strict()', () => {
        expect(timelineQuerySchema.safeParse(baseQuery({ assignee_id: ID })).success).toBe(false);
    });

    it('rejects malformed dates (not YYYY-MM-DD)', () => {
        expect(timelineQuerySchema.safeParse({ from_date: '01/01/2026', to_date: '2026-03-31' }).success).toBe(false);
    });
});

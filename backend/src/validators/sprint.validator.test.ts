import { describe, expect, it } from 'vitest';

import { completeSprintBodySchema } from './sprint.validator.js';

/**
 * Phase 2 Backlog — `POST /sprints/:id/complete` body. `move_unfinished_to`
 * accepts the literal `'backlog'` (default) or a target sprint ObjectId.
 */

const VALID_OID = 'a'.repeat(24);

describe('completeSprintBodySchema', () => {
    it("defaults move_unfinished_to to 'backlog' when omitted", () => {
        const parsed = completeSprintBodySchema.parse({});
        expect(parsed.move_unfinished_to).toBe('backlog');
    });

    it("accepts the literal 'backlog'", () => {
        expect(completeSprintBodySchema.safeParse({ move_unfinished_to: 'backlog' }).success).toBe(true);
    });

    it('accepts a target sprint ObjectId', () => {
        const r = completeSprintBodySchema.safeParse({ move_unfinished_to: VALID_OID });
        expect(r.success).toBe(true);
    });

    it('rejects an arbitrary string that is neither backlog nor an ObjectId', () => {
        expect(completeSprintBodySchema.safeParse({ move_unfinished_to: 'somewhere' }).success).toBe(false);
    });
});

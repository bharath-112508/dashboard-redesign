import { describe, expect, it } from 'vitest';

import { generateLetterBodySchema } from './letter.validator.js';

/**
 * Validator-refine tests (Task 8 fix pass).
 *
 * `generateLetterBodySchema` is a flat `.strict()` schema where every
 * type-specific field is optional at the top level — without the
 * `superRefine` below, `{ type: 'offer', user_id }` alone would pass
 * validation and silently generate a blank, persisted, downloadable PDF
 * ("Dear Candidate ... the role offered" with an empty CTC table). These
 * tests pin the per-type required-field contract added by the refine.
 */

const USER_ID = 'a'.repeat(24);

describe('generateLetterBodySchema — offer', () => {
    it('rejects an offer body missing candidate_name/designation/ctc_breakdown', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'offer',
            user_id: USER_ID,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('candidate_name');
            expect(paths).toContain('designation');
            expect(paths).toContain('ctc_breakdown');
        }
    });

    it('accepts a fully-populated offer body', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'offer',
            user_id: USER_ID,
            candidate_name: 'John Doe',
            designation: 'Software Engineer',
            ctc_breakdown: [{ label: 'Basic', amount: 500000 }],
        });
        expect(result.success).toBe(true);
    });

    it('rejects an empty ctc_breakdown array', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'offer',
            user_id: USER_ID,
            candidate_name: 'John Doe',
            designation: 'Software Engineer',
            ctc_breakdown: [],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('ctc_breakdown');
        }
    });
});

describe('generateLetterBodySchema — hike / promotion', () => {
    it('rejects a promotion body missing effective_date/new_designation', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'promotion',
            user_id: USER_ID,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('effective_date');
            expect(paths).toContain('new_designation');
        }
    });

    it('accepts a populated promotion body', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'promotion',
            user_id: USER_ID,
            effective_date: '2026-04-01',
            new_designation: 'Staff Engineer',
        });
        expect(result.success).toBe(true);
    });

    it('rejects a hike body missing effective_date/new_designation', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'hike',
            user_id: USER_ID,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('effective_date');
            expect(paths).toContain('new_designation');
        }
    });

    it('accepts a populated hike body', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'hike',
            user_id: USER_ID,
            effective_date: '2026-04-01',
            new_designation: 'Senior Engineer',
        });
        expect(result.success).toBe(true);
    });
});

describe('generateLetterBodySchema — relieving / experience', () => {
    it('rejects a relieving body missing last_working_day', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'relieving',
            user_id: USER_ID,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('last_working_day');
        }
    });

    it('accepts a populated relieving body', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'relieving',
            user_id: USER_ID,
            last_working_day: '2026-04-01',
        });
        expect(result.success).toBe(true);
    });

    it('rejects an experience body missing last_working_day', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'experience',
            user_id: USER_ID,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('last_working_day');
        }
    });

    it('accepts a populated experience body', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'experience',
            user_id: USER_ID,
            last_working_day: '2026-04-01',
        });
        expect(result.success).toBe(true);
    });
});

describe('generateLetterBodySchema — internship (unconstrained)', () => {
    it('accepts an internship body with only the base fields', () => {
        const result = generateLetterBodySchema.safeParse({
            type: 'internship',
            user_id: USER_ID,
        });
        expect(result.success).toBe(true);
    });
});

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

// ─── internship_offer ────────────────────────────────────────────────────
//
// Distinct from `internship` (the EXPERIENCE letter issued at the end).
// Every field is optional at the flat-schema level, so these refinements are
// the only thing standing between a typo and a letter that generates with a
// blank position, no dates, or a silent "₹0 per month".

describe('generateLetterBodySchema — internship_offer', () => {
    const valid = {
        type: 'internship_offer' as const,
        candidate_name: 'Aarav Sharma',
        position: 'AI Intern',
        internship_start_date: '2026-07-18',
        internship_end_date: '2026-10-18',
        internship_duration: '3 Months',
        work_mode: 'Remote',
        is_paid: false,
    };

    it('accepts a manually-named intern with no user_id', () => {
        // An intern is usually not a platform user when the offer goes out.
        const parsed = generateLetterBodySchema.parse(valid);
        expect(parsed.candidate_name).toBe('Aarav Sharma');
        expect(parsed.user_id).toBeUndefined();
    });

    it('requires a name when no user_id is given', () => {
        const { candidate_name: _drop, ...rest } = valid;
        expect(() => generateLetterBodySchema.parse(rest)).toThrow();
    });

    it('requires position and both dates', () => {
        for (const field of ['position', 'internship_start_date', 'internship_end_date'] as const) {
            const body: Record<string, unknown> = { ...valid };
            delete body[field];
            expect(() => generateLetterBodySchema.parse(body), field).toThrow();
        }
    });

    it('rejects an end date before the start date', () => {
        expect(() =>
            generateLetterBodySchema.parse({
                ...valid,
                internship_start_date: '2026-10-18',
                internship_end_date: '2026-07-18',
            })
        ).toThrow();
    });

    it('requires a stipend amount when the internship is PAID', () => {
        // Otherwise the letter renders "Stipend of ₹0 per month", which is
        // worse than saying nothing.
        expect(() => generateLetterBodySchema.parse({ ...valid, is_paid: true })).toThrow();
        expect(() => generateLetterBodySchema.parse({ ...valid, is_paid: true, stipend_amount: 0 })).toThrow();
    });

    it('accepts a paid internship with an amount', () => {
        const parsed = generateLetterBodySchema.parse({
            ...valid,
            is_paid: true,
            stipend_amount: 15000,
            stipend_note: 'paid on the 5th',
        });
        expect(parsed.stipend_amount).toBe(15000);
    });

    it('does NOT require a stipend when unpaid', () => {
        expect(() => generateLetterBodySchema.parse({ ...valid, is_paid: false })).not.toThrow();
    });

    it('accepts editable responsibilities and terms', () => {
        const parsed = generateLetterBodySchema.parse({
            ...valid,
            responsibilities: ['Work on AI projects.'],
            general_terms: ['Maintain confidentiality.'],
        });
        expect(parsed.responsibilities).toEqual(['Work on AI projects.']);
        expect(parsed.general_terms).toEqual(['Maintain confidentiality.']);
    });

    it('still requires user_id for the internship EXPERIENCE letter', () => {
        // The two must not blur: `internship` is about someone who worked
        // here, so it is always tied to a real user.
        expect(() => generateLetterBodySchema.parse({ type: 'internship', candidate_name: 'Aarav' })).toThrow();
    });
});

import { describe, expect, it } from 'vitest';

import {
    createTaskTemplateBodySchema,
    instantiateTaskTemplateBodySchema,
    listTaskTemplatesQuerySchema,
    patchTaskTemplateBodySchema,
} from './task-template.validator.js';

/**
 * Validator tests for `/task-templates` (Phase 4 Step 40).
 *
 * The recurrence sub-doc carries cross-field rules that the service
 * trusts after parsing — so these tests are the contract surface for
 * "what shape can survive into runtime."
 */

const validBaseBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Weekly status update',
    title: 'Status update — week of {{date}}',
    ...overrides,
});

const ID = 'a'.repeat(24);

// ─── Create body ──────────────────────────────────────────────────────

describe('createTaskTemplateBodySchema', () => {
    it('accepts a minimal body (name + title)', () => {
        const parsed = createTaskTemplateBodySchema.parse(validBaseBody());
        expect(parsed.name).toBe('Weekly status update');
        expect(parsed.priority).toBe('medium'); // default
        expect(parsed.recurrence).toBeNull();
    });

    it('rejects an empty name', () => {
        const result = createTaskTemplateBodySchema.safeParse(validBaseBody({ name: '   ' }));
        expect(result.success).toBe(false);
    });

    it('rejects extra top-level keys via .strict()', () => {
        const result = createTaskTemplateBodySchema.safeParse({ ...validBaseBody(), nope: 1 });
        expect(result.success).toBe(false);
    });

    it('rejects out-of-range default_due_offset_days', () => {
        const result = createTaskTemplateBodySchema.safeParse(validBaseBody({ default_due_offset_days: 999_999 }));
        expect(result.success).toBe(false);
    });
});

// ─── Recurrence cross-field refines ───────────────────────────────────

describe('createTaskTemplateBodySchema (recurrence)', () => {
    const dailyRule = {
        enabled: true,
        frequency: 'daily',
        weekdays: [],
        day_of_month: null,
        start_date: '2026-01-01',
        end_date: null,
    };

    const weeklyRule = {
        ...dailyRule,
        frequency: 'weekly',
        weekdays: [1, 3, 5], // Mon Wed Fri
    };

    const monthlyRule = {
        ...dailyRule,
        frequency: 'monthly',
        day_of_month: 15,
    };

    it('accepts a valid daily rule', () => {
        const result = createTaskTemplateBodySchema.safeParse(validBaseBody({ recurrence: dailyRule }));
        expect(result.success).toBe(true);
    });

    it('accepts a valid weekly rule and dedupes weekdays', () => {
        const parsed = createTaskTemplateBodySchema.parse(
            validBaseBody({
                recurrence: { ...weeklyRule, weekdays: [1, 3, 5, 1, 3] }, // duplicates
            })
        );
        // Sorted + deduped
        expect(parsed.recurrence?.weekdays).toEqual([1, 3, 5]);
    });

    it('accepts a valid monthly rule', () => {
        const result = createTaskTemplateBodySchema.safeParse(validBaseBody({ recurrence: monthlyRule }));
        expect(result.success).toBe(true);
    });

    it('rejects weekly with empty weekdays', () => {
        const result = createTaskTemplateBodySchema.safeParse(
            validBaseBody({ recurrence: { ...weeklyRule, weekdays: [] } })
        );
        expect(result.success).toBe(false);
    });

    it('rejects weekly with day_of_month set (cross-field mismatch)', () => {
        const result = createTaskTemplateBodySchema.safeParse(
            validBaseBody({ recurrence: { ...weeklyRule, day_of_month: 15 } })
        );
        expect(result.success).toBe(false);
    });

    it('rejects monthly with weekdays set (cross-field mismatch)', () => {
        const result = createTaskTemplateBodySchema.safeParse(
            validBaseBody({ recurrence: { ...monthlyRule, weekdays: [1] } })
        );
        expect(result.success).toBe(false);
    });

    it('rejects monthly with null day_of_month', () => {
        const result = createTaskTemplateBodySchema.safeParse(
            validBaseBody({ recurrence: { ...monthlyRule, day_of_month: null } })
        );
        expect(result.success).toBe(false);
    });

    it('rejects daily with weekdays present', () => {
        const result = createTaskTemplateBodySchema.safeParse(
            validBaseBody({ recurrence: { ...dailyRule, weekdays: [1] } })
        );
        expect(result.success).toBe(false);
    });

    it('rejects monthly with day_of_month > 28 (Feb-safe cap)', () => {
        const result = createTaskTemplateBodySchema.safeParse(
            validBaseBody({ recurrence: { ...monthlyRule, day_of_month: 31 } })
        );
        expect(result.success).toBe(false);
    });

    it('rejects start_date > end_date', () => {
        const result = createTaskTemplateBodySchema.safeParse(
            validBaseBody({
                recurrence: { ...dailyRule, start_date: '2026-12-31', end_date: '2026-01-01' },
            })
        );
        expect(result.success).toBe(false);
    });
});

// ─── Patch body ────────────────────────────────────────────────────────

describe('patchTaskTemplateBodySchema', () => {
    it('accepts an empty body (no-op patch)', () => {
        expect(patchTaskTemplateBodySchema.safeParse({}).success).toBe(true);
    });

    it('accepts is_archived flag for soft-archival', () => {
        const parsed = patchTaskTemplateBodySchema.parse({ is_archived: true });
        expect(parsed.is_archived).toBe(true);
    });

    it('rejects extra keys via .strict()', () => {
        expect(patchTaskTemplateBodySchema.safeParse({ malicious: 1 }).success).toBe(false);
    });
});

// ─── List query ───────────────────────────────────────────────────────

describe('listTaskTemplatesQuerySchema', () => {
    it('coerces is_archived from string', () => {
        const parsed = listTaskTemplatesQuerySchema.parse({ is_archived: 'true' });
        expect(parsed.is_archived).toBe(true);
    });

    it('coerces recurring_only from string', () => {
        const parsed = listTaskTemplatesQuerySchema.parse({ recurring_only: 'false' });
        expect(parsed.recurring_only).toBe(false);
    });

    it('caps limit at 100', () => {
        expect(listTaskTemplatesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });
});

// ─── Instantiate body ─────────────────────────────────────────────────

describe('instantiateTaskTemplateBodySchema', () => {
    it('accepts an empty body (use all defaults)', () => {
        expect(instantiateTaskTemplateBodySchema.safeParse({}).success).toBe(true);
    });

    it('accepts overrides for any subset of fields', () => {
        const parsed = instantiateTaskTemplateBodySchema.parse({
            title: 'One-off override',
            primary_assignee_id: ID,
            collaborator_ids: [ID],
            due_date: '2026-05-10',
        });
        expect(parsed.title).toBe('One-off override');
        expect(parsed.primary_assignee_id).toBe(ID);
        expect(parsed.due_date).toBe('2026-05-10');
    });

    it('rejects malformed due_date', () => {
        expect(instantiateTaskTemplateBodySchema.safeParse({ due_date: '2026/01/01' }).success).toBe(false);
    });

    it('rejects extra keys via .strict()', () => {
        expect(instantiateTaskTemplateBodySchema.safeParse({ foo: 'bar' }).success).toBe(false);
    });
});

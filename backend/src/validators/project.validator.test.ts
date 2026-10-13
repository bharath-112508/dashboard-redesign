import { describe, expect, it } from 'vitest';

import { patchDefaultStatusOrdersBodySchema, patchProjectBodySchema } from './project.validator.js';

describe('patchProjectBodySchema — board settings', () => {
    it('accepts wip limits and rejects duplicates / bad limits', () => {
        expect(
            patchProjectBodySchema.safeParse({ board_wip_limits: [{ status_key: 'to_do', limit: 5 }] }).success
        ).toBe(true);
        expect(
            patchProjectBodySchema.safeParse({ board_wip_limits: [{ status_key: 'to_do', limit: 0 }] }).success
        ).toBe(false);
        expect(
            patchProjectBodySchema.safeParse({
                board_wip_limits: [
                    { status_key: 'to_do', limit: 2 },
                    { status_key: 'to_do', limit: 3 },
                ],
            }).success
        ).toBe(false);
        expect(patchProjectBodySchema.safeParse({ board_wip_limits: [] }).success).toBe(true);
    });

    it('accepts quick filters and enforces name, shape and cap', () => {
        const qf = { name: 'Bugs', criteria: { issue_types: ['bug'], due: 'overdue', story_ids: ['__none__'] } };
        expect(patchProjectBodySchema.safeParse({ board_quick_filters: [qf] }).success).toBe(true);
        expect(patchProjectBodySchema.safeParse({ board_quick_filters: [{ ...qf, name: '' }] }).success).toBe(false);
        expect(patchProjectBodySchema.safeParse({ board_quick_filters: Array(21).fill(qf) }).success).toBe(false);
        expect(
            patchProjectBodySchema.safeParse({ board_quick_filters: [{ ...qf, criteria: { due: 'someday' } }] }).success
        ).toBe(false);
        expect(
            patchProjectBodySchema.safeParse({ board_quick_filters: [{ ...qf, criteria: { jql: 'x' } }] }).success
        ).toBe(false);
    });
});

describe('patchDefaultStatusOrdersBodySchema with bug', () => {
    const five = ['to_do', 'in_progress', 'bug', 'review', 'done'].map((key, i) => ({ key, order: (i + 1) * 100 }));
    it('accepts all five built-ins', () => {
        expect(patchDefaultStatusOrdersBodySchema.safeParse({ orders: five }).success).toBe(true);
    });
    it('rejects the old four', () => {
        const four = five.filter((o) => o.key !== 'bug');
        expect(patchDefaultStatusOrdersBodySchema.safeParse({ orders: four }).success).toBe(false);
    });
});

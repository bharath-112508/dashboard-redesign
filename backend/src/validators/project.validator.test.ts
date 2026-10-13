import { describe, expect, it } from 'vitest';

import { createProjectBodySchema, patchDefaultStatusOrdersBodySchema, patchProjectBodySchema } from './project.validator.js';

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

// ─── Redesign: planned / maintenance states, area, support plan ──────────

describe('project redesign fields', () => {
    const base = { name: 'Driver app', start_date: '2026-10-01' };

    it.each(['planned', 'maintenance'])('accepts status %s on create and patch', (status) => {
        expect(createProjectBodySchema.safeParse({ ...base, status }).success).toBe(true);
        expect(patchProjectBodySchema.safeParse({ status }).success).toBe(true);
    });

    it('accepts an area and a support plan on create and patch', () => {
        const extra = { area: 'Infra', support_plan: { until: '2027-06-30', quota_hours: 20 } };
        expect(createProjectBodySchema.safeParse({ ...base, ...extra }).success).toBe(true);
        expect(patchProjectBodySchema.safeParse(extra).success).toBe(true);
        expect(patchProjectBodySchema.safeParse({ support_plan: null }).success).toBe(true);
    });

    it('rejects a support plan with negative hours or a non-ISO date', () => {
        expect(patchProjectBodySchema.safeParse({ support_plan: { until: '2027-06-30', quota_hours: -1 } }).success).toBe(false);
        expect(patchProjectBodySchema.safeParse({ support_plan: { until: '30/06/2027', quota_hours: 5 } }).success).toBe(false);
    });
});

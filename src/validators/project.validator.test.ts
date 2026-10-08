import { describe, expect, it } from 'vitest';

import { patchProjectBodySchema } from './project.validator.js';

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

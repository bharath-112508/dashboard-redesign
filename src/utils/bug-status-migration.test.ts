import { describe, expect, it } from 'vitest';

import { planBugStatusMigration } from './bug-status-migration.js';

const p = (id: string, keys: string[], custom: string[] = []) => ({
    _id: id,
    name: `P${id}`,
    default_status_orders: keys.map((key) => ({ key })),
    custom_task_statuses: custom.map((key) => ({ key })),
});

describe('planBugStatusMigration', () => {
    it('updates projects missing bug, skips ones that have it (idempotent)', () => {
        const plan = planBugStatusMigration([
            p('1', ['to_do', 'in_progress', 'review', 'done']),
            p('2', ['to_do', 'in_progress', 'bug', 'review', 'done']),
        ]);
        expect(plan).toEqual({ toUpdate: ['1'], alreadyDone: 1, conflicts: [] });
    });
    it('reports, and does not update, a project with a custom status keyed bug', () => {
        const plan = planBugStatusMigration([p('3', ['to_do', 'in_progress', 'review', 'done'], ['bug'])]);
        expect(plan).toEqual({ toUpdate: [], alreadyDone: 0, conflicts: [{ id: '3', name: 'P3' }] });
    });
    it('treats a missing array as needing the update', () => {
        expect(planBugStatusMigration([{ _id: '4', name: 'P4' }]).toUpdate).toEqual(['4']);
    });
});

describe('planBugStatusMigration — custom bug wins', () => {
    it('reports a conflict even if a built-in bug was already written next to the custom one', () => {
        const plan = planBugStatusMigration([p('5', ['to_do', 'in_progress', 'bug', 'review', 'done'], ['bug'])]);
        expect(plan).toEqual({ toUpdate: [], alreadyDone: 0, conflicts: [{ id: '5', name: 'P5' }] });
    });
});

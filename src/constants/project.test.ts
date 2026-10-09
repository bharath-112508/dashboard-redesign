import { describe, expect, it } from 'vitest';

import { DEFAULT_STATUS_ORDER_VALUES, DEFAULT_TASK_STATUS_KEYS, withAllDefaultStatuses } from './project.js';
import { DEFAULT_TASK_STATUS_VALUES } from './task.js';
import { IN_PROGRESS_TASK_STATUS_KEYS } from './story.js';

const LEGACY = [
    { key: 'to_do', order: 100, is_active: true },
    { key: 'in_progress', order: 200, is_active: true },
    { key: 'review', order: 300, is_active: false },
    { key: 'done', order: 400, is_active: true },
];

describe('bug built-in', () => {
    it('is the fifth built-in at order 250, valid as a task status, counted as in progress', () => {
        expect(DEFAULT_TASK_STATUS_KEYS).toEqual(['to_do', 'in_progress', 'bug', 'review', 'done']);
        expect(DEFAULT_STATUS_ORDER_VALUES.bug).toBe(250);
        expect(DEFAULT_TASK_STATUS_VALUES).toContain('bug');
        expect(IN_PROGRESS_TASK_STATUS_KEYS).toContain('bug');
    });
});

describe('withAllDefaultStatuses', () => {
    it('appends a missing built-in at its canonical order, active, keeping existing entries as-is', () => {
        expect(withAllDefaultStatuses(LEGACY)).toEqual([...LEGACY, { key: 'bug', order: 250, is_active: true }]);
    });
    it('is a no-op when every built-in is present', () => {
        const full = withAllDefaultStatuses(LEGACY);
        expect(withAllDefaultStatuses(full)).toEqual(full);
    });
    it('fills everything for an empty array', () => {
        expect(withAllDefaultStatuses([]).map((o) => o.key)).toEqual([...DEFAULT_TASK_STATUS_KEYS]);
    });
});

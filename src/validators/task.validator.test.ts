import { describe, expect, it } from 'vitest';

import {
    createTaskBodySchema,
    labelsSchema,
    listTasksQuerySchema,
    patchTaskBodySchema,
    rankTaskBodySchema,
} from './task.validator.js';
import { TASK_LABELS_MAX, TASK_LABEL_MAX_LEN } from '../constants/task.js';

/**
 * BUG-041 — when status === 'done', due_date must be <= today.
 *
 * These tests focus exclusively on the Done/due-date refinement. The
 * other field-shape checks (title length, ObjectId format, etc.) are
 * exercised by the integration smoke tests.
 */

const todayIso = (): string => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const daysFromTodayIso = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const VALID_OID = 'a'.repeat(24);

describe('createTaskBodySchema — BUG-041 done+future-date guard', () => {
    it('accepts status=done with due_date = today', () => {
        const r = createTaskBodySchema.safeParse({
            project_id: VALID_OID,
            title: 'finished thing',
            status: 'done',
            due_date: todayIso(),
        });
        expect(r.success).toBe(true);
    });

    it('accepts status=done with due_date in the past', () => {
        const r = createTaskBodySchema.safeParse({
            project_id: VALID_OID,
            title: 'finished thing',
            status: 'done',
            due_date: daysFromTodayIso(-7),
        });
        expect(r.success).toBe(true);
    });

    it('rejects status=done with a future due_date', () => {
        const r = createTaskBodySchema.safeParse({
            project_id: VALID_OID,
            title: 'finished thing',
            status: 'done',
            due_date: daysFromTodayIso(+3),
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            const issue = r.error.issues.find((i) => i.path.join('.') === 'due_date');
            expect(issue?.message).toMatch(/Done.*future/i);
        }
    });

    it('allows future due_date when status is not done', () => {
        const r = createTaskBodySchema.safeParse({
            project_id: VALID_OID,
            title: 'planned thing',
            status: 'to_do',
            due_date: daysFromTodayIso(+30),
        });
        expect(r.success).toBe(true);
    });

    it('allows future due_date when status is omitted (defaults to to_do downstream)', () => {
        const r = createTaskBodySchema.safeParse({
            project_id: VALID_OID,
            title: 'planned thing',
            due_date: daysFromTodayIso(+30),
        });
        expect(r.success).toBe(true);
    });
});

describe('patchTaskBodySchema — BUG-041 done+future-date guard', () => {
    it('rejects patching status=done while due_date is future', () => {
        const r = patchTaskBodySchema.safeParse({
            status: 'done',
            due_date: daysFromTodayIso(+5),
        });
        expect(r.success).toBe(false);
    });

    it('accepts status=done with past/today due_date in the same patch', () => {
        const r = patchTaskBodySchema.safeParse({
            status: 'done',
            due_date: todayIso(),
        });
        expect(r.success).toBe(true);
    });

    it('no-ops the refinement when due_date is patched alone (status unchanged)', () => {
        // PATCH may carry only one field — the refinement no-ops without
        // both `status` and `due_date`. The service layer is responsible
        // for re-checking against the resulting state if needed.
        const r = patchTaskBodySchema.safeParse({ due_date: daysFromTodayIso(+5) });
        expect(r.success).toBe(true);
    });

    it('no-ops the refinement when status is patched alone', () => {
        const r = patchTaskBodySchema.safeParse({ status: 'done' });
        expect(r.success).toBe(true);
    });
});

/**
 * Phase-1 Jira-workflow fields on `/tasks`:
 *  - `issue_type` — enum (task | bug | improvement).
 *  - `story_points` — Fibonacci set or `null`; free numbers rejected.
 *  - `task_number` — server-owned; must be stripped from client input.
 */

const validCreate = (overrides: Record<string, unknown> = {}) => ({
    project_id: VALID_OID,
    title: 'New task',
    due_date: '2026-05-10',
    ...overrides,
});

describe('createTaskBodySchema — issue_type', () => {
    it('accepts each valid issue type', () => {
        for (const t of ['task', 'bug', 'improvement']) {
            expect(createTaskBodySchema.parse(validCreate({ issue_type: t })).issue_type).toBe(t);
        }
    });

    it('rejects an unknown issue type', () => {
        expect(createTaskBodySchema.safeParse(validCreate({ issue_type: 'epic' })).success).toBe(false);
    });

    it('is optional (defaults handled by the service)', () => {
        expect(createTaskBodySchema.safeParse(validCreate()).success).toBe(true);
    });
});

describe('createTaskBodySchema — story_points', () => {
    it('accepts each Fibonacci value', () => {
        for (const p of [1, 2, 3, 5, 8, 13, 21]) {
            expect(createTaskBodySchema.parse(validCreate({ story_points: p })).story_points).toBe(p);
        }
    });

    it('accepts null (unestimated)', () => {
        expect(createTaskBodySchema.parse(validCreate({ story_points: null })).story_points).toBeNull();
    });

    it('rejects a non-Fibonacci number', () => {
        expect(createTaskBodySchema.safeParse(validCreate({ story_points: 4 })).success).toBe(false);
        expect(createTaskBodySchema.safeParse(validCreate({ story_points: 100 })).success).toBe(false);
    });
});

describe('createTaskBodySchema — task_number is server-owned', () => {
    it('strips a client-supplied task_number', () => {
        const parsed = createTaskBodySchema.parse(validCreate({ task_number: 999 }));
        expect('task_number' in parsed).toBe(false);
    });
});

describe('patchTaskBodySchema — Phase-1 fields', () => {
    it('accepts issue_type and story_points patches', () => {
        expect(patchTaskBodySchema.safeParse({ issue_type: 'bug' }).success).toBe(true);
        expect(patchTaskBodySchema.safeParse({ story_points: 8 }).success).toBe(true);
        expect(patchTaskBodySchema.safeParse({ story_points: null }).success).toBe(true);
    });

    it('rejects a non-Fibonacci story_points patch', () => {
        expect(patchTaskBodySchema.safeParse({ story_points: 7 }).success).toBe(false);
    });

    it('strips a client-supplied task_number on patch', () => {
        const parsed = patchTaskBodySchema.parse({ task_number: 3, issue_type: 'bug' });
        expect('task_number' in parsed).toBe(false);
    });
});

/**
 * Phase 3c — freeform labels (`labelsSchema`).
 *  - trims each label
 *  - drops empty / whitespace-only entries (NOT rejected)
 *  - dedupes case-insensitively, first spelling wins
 *  - rejects any label longer than TASK_LABEL_MAX_LEN
 *  - caps the raw array at TASK_LABELS_MAX
 */
describe('labelsSchema — Phase 3c', () => {
    it('trims surrounding whitespace on each label', () => {
        expect(labelsSchema.parse(['  frontend  ', ' bug'])).toEqual(['frontend', 'bug']);
    });

    it('drops empty and whitespace-only entries', () => {
        expect(labelsSchema.parse(['keep', '', '   ', 'also'])).toEqual(['keep', 'also']);
    });

    it('dedupes case-insensitively, first spelling wins', () => {
        expect(labelsSchema.parse(['Bug', 'bug', 'BUG', 'Frontend'])).toEqual(['Bug', 'Frontend']);
    });

    it('rejects a label longer than TASK_LABEL_MAX_LEN', () => {
        expect(labelsSchema.safeParse(['a'.repeat(TASK_LABEL_MAX_LEN + 1)]).success).toBe(false);
        expect(labelsSchema.safeParse(['a'.repeat(TASK_LABEL_MAX_LEN)]).success).toBe(true);
    });

    it('caps the array at TASK_LABELS_MAX', () => {
        const under = Array.from({ length: TASK_LABELS_MAX }, (_, i) => `l${i}`);
        const over = Array.from({ length: TASK_LABELS_MAX + 1 }, (_, i) => `l${i}`);
        expect(labelsSchema.safeParse(under).success).toBe(true);
        expect(labelsSchema.safeParse(over).success).toBe(false);
    });

    it('accepts an empty array', () => {
        expect(labelsSchema.parse([])).toEqual([]);
    });
});

describe('createTaskBodySchema / patchTaskBodySchema — labels wiring', () => {
    it('is optional on create and transforms when supplied', () => {
        expect(createTaskBodySchema.safeParse(validCreate()).success).toBe(true);
        const parsed = createTaskBodySchema.parse(validCreate({ labels: [' UI ', 'ui', 'api'] }));
        expect(parsed.labels).toEqual(['UI', 'api']);
    });

    it('is accepted (and transformed) on patch', () => {
        const parsed = patchTaskBodySchema.parse({ labels: ['X', 'x', ' y '] });
        expect(parsed.labels).toEqual(['X', 'y']);
    });
});

describe('rankTaskBodySchema — Phase 2 Backlog', () => {
    it('accepts an empty body (move to top)', () => {
        expect(rankTaskBodySchema.safeParse({}).success).toBe(true);
    });

    it('accepts a single after_task_id', () => {
        expect(rankTaskBodySchema.safeParse({ after_task_id: VALID_OID }).success).toBe(true);
    });

    it('accepts a single before_task_id', () => {
        expect(rankTaskBodySchema.safeParse({ before_task_id: VALID_OID }).success).toBe(true);
    });

    it('accepts explicit nulls', () => {
        expect(rankTaskBodySchema.safeParse({ after_task_id: null, before_task_id: null }).success).toBe(true);
    });

    it('rejects supplying BOTH after and before', () => {
        expect(rankTaskBodySchema.safeParse({ after_task_id: VALID_OID, before_task_id: VALID_OID }).success).toBe(
            false
        );
    });

    it('rejects a malformed ObjectId', () => {
        expect(rankTaskBodySchema.safeParse({ after_task_id: 'not-an-id' }).success).toBe(false);
    });
});

describe('due_date is optional', () => {
    it('create accepts an omitted or null due_date', () => {
        expect(createTaskBodySchema.safeParse({ project_id: VALID_OID, title: 'no date' }).success).toBe(true);
        expect(
            createTaskBodySchema.safeParse({ project_id: VALID_OID, title: 'no date', due_date: null }).success
        ).toBe(true);
    });

    it('patch accepts null to clear the due date', () => {
        expect(patchTaskBodySchema.safeParse({ due_date: null }).success).toBe(true);
    });

    it('still rejects a malformed date', () => {
        expect(
            createTaskBodySchema.safeParse({ project_id: VALID_OID, title: 'x', due_date: '12/10/2026' }).success
        ).toBe(false);
    });
});

describe('is_flagged', () => {
    it('patch accepts a boolean flag', () => {
        expect(patchTaskBodySchema.safeParse({ is_flagged: true }).success).toBe(true);
        expect(patchTaskBodySchema.safeParse({ is_flagged: 'yes' }).success).toBe(false);
    });
});

describe('listTasksQuerySchema include_cover', () => {
    it('accepts "true"/"false" strings and rejects junk', () => {
        expect(listTasksQuerySchema.parse({ include_cover: 'true' }).include_cover).toBe(true);
        expect(listTasksQuerySchema.parse({ include_cover: 'false' }).include_cover).toBe(false);
        expect(listTasksQuerySchema.safeParse({ include_cover: 'yes' }).success).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';

import { createTaskBodySchema, patchTaskBodySchema } from './task.validator.js';

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

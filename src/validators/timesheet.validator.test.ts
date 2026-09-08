import { describe, expect, it } from 'vitest';

import { createTimesheetBodySchema, patchTimesheetBodySchema } from './timesheet.validator.js';

/**
 * A `general` entry is the "log time without a task" path. It still belongs to
 * a project: every logged hour rolls up to one, so the project is mandatory
 * and `general_category` is an optional label on top of it ("Standup",
 * "Onboarding"), never a substitute for it.
 */
describe('createTimesheetBodySchema — general entries', () => {
    const base = {
        local_date: '2026-09-03',
        entry_type: 'general' as const,
        billable_hours: 2,
        billable_minutes: 0,
        non_billable_hours: 0,
        non_billable_minutes: 0,
        // Notes are mandatory on every entry.
        description: 'Reviewed the supplier onboarding flow',
    };
    const projectId = 'a'.repeat(24);

    it('accepts a project with no category', () => {
        const parsed = createTimesheetBodySchema.safeParse({ ...base, project_id: projectId });
        expect(parsed.success).toBe(true);
    });

    it('accepts a project with a category', () => {
        const parsed = createTimesheetBodySchema.safeParse({
            ...base,
            project_id: projectId,
            general_category: 'Standup',
        });
        expect(parsed.success).toBe(true);
    });

    it('rejects a category with no project — a label is not an attribution', () => {
        const parsed = createTimesheetBodySchema.safeParse({ ...base, general_category: 'Standup' });
        expect(parsed.success).toBe(false);
    });

    it('rejects an entry with no project at all', () => {
        const parsed = createTimesheetBodySchema.safeParse(base);
        expect(parsed.success).toBe(false);
    });

    it('rejects an explicitly null project', () => {
        // The old schema accepted `null` here; the FE sent it for internal
        // time. It must now fail rather than fall through to a null column.
        const parsed = createTimesheetBodySchema.safeParse({ ...base, project_id: null });
        expect(parsed.success).toBe(false);
    });

    it('rejects an entry with no note', () => {
        const { description: _omitted, ...noNote } = base;
        expect(createTimesheetBodySchema.safeParse({ ...noNote, project_id: projectId }).success).toBe(false);
    });

    it('rejects a whitespace-only note', () => {
        const parsed = createTimesheetBodySchema.safeParse({
            ...base,
            project_id: projectId,
            description: '   ',
        });
        expect(parsed.success).toBe(false);
    });

    it('still requires a task for a task_linked entry', () => {
        const parsed = createTimesheetBodySchema.safeParse({
            ...base,
            entry_type: 'task_linked',
            project_id: projectId,
        });
        expect(parsed.success).toBe(false);
    });
});

describe('patchTimesheetBodySchema — notes', () => {
    it('allows editing only the hours, without resending the note', () => {
        const parsed = patchTimesheetBodySchema.safeParse({ billable_hours: 3, billable_minutes: 0 });
        expect(parsed.success).toBe(true);
    });

    it('allows clearing the category with null — it is only a label', () => {
        expect(patchTimesheetBodySchema.safeParse({ general_category: null }).success).toBe(true);
    });

    it('allows MOVING an entry to another project', () => {
        expect(patchTimesheetBodySchema.safeParse({ project_id: 'b'.repeat(24) }).success).toBe(true);
    });

    it('refuses to clear the project — every entry keeps one', () => {
        expect(patchTimesheetBodySchema.safeParse({ project_id: null }).success).toBe(false);
    });

    it('still refuses an empty-string category', () => {
        // '' is the un-representable state the create schema already rejects;
        // `null` is how you clear it.
        expect(patchTimesheetBodySchema.safeParse({ general_category: '' }).success).toBe(false);
    });

    it('refuses to blank an existing note', () => {
        // The KEY is optional on a partial patch; the VALUE never may be empty.
        const parsed = patchTimesheetBodySchema.safeParse({ description: '' });
        expect(parsed.success).toBe(false);
    });
});

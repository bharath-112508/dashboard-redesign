import { describe, expect, it } from 'vitest';

import { createTimesheetBodySchema, patchTimesheetBodySchema } from './timesheet.validator.js';

/**
 * A `general` entry is the "log time without a task" path. It must stay
 * attributable — to a project, a category, or both — but must NOT demand a
 * free-text category when a project already answers "what was this for?".
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

    it('accepts a category with no project', () => {
        const parsed = createTimesheetBodySchema.safeParse({ ...base, general_category: 'Standup' });
        expect(parsed.success).toBe(true);
    });

    it('rejects an entry with neither — nothing to attribute the time to', () => {
        const parsed = createTimesheetBodySchema.safeParse(base);
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

    it('allows clearing the category with null, now that a task is optional', () => {
        expect(patchTimesheetBodySchema.safeParse({ general_category: null }).success).toBe(true);
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

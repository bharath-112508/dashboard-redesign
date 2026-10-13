import { describe, expect, it } from 'vitest';

import { createTimesheetBodySchema, patchTimesheetBodySchema } from './timesheet.validator.js';

/**
 * A `general` entry is the "log time without a task" path. It is attributed by
 * a PROJECT or by a CATEGORY — at least one, never neither. The category is a
 * closed list so internal time can be grouped ("Meeting", "Support"); free text
 * could not be, and became a second description box.
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
            general_category: 'Meeting',
        });
        expect(parsed.success).toBe(true);
    });

    // Reversed: every new entry names a project, internal time included. These
    // two are kept pointing the other way rather than deleted — the rule has
    // moved in both directions once already, and a bare "rejects" leaves no
    // record of which shapes used to be legal.
    it('rejects a category with no project', () => {
        const parsed = createTimesheetBodySchema.safeParse({ ...base, general_category: 'Meeting' });
        expect(parsed.success).toBe(false);
    });

    it('rejects an explicitly null project', () => {
        const parsed = createTimesheetBodySchema.safeParse({
            ...base,
            project_id: null,
            general_category: 'Support',
        });
        expect(parsed.success).toBe(false);
    });

    it('rejects an entry with no project at all', () => {
        const parsed = createTimesheetBodySchema.safeParse(base);
        expect(parsed.success).toBe(false);
    });

    it('accepts FREE TEXT as the category when a project is chosen', () => {
        // With a project carrying the attribution the field only refines it —
        // it names the area worked on and has no grouping load.
        const parsed = createTimesheetBodySchema.safeParse({
            ...base,
            project_id: projectId,
            general_category: 'Payroll module — PDF export',
        });
        expect(parsed.success).toBe(true);
    });

    it('takes any free text as the category now the list is gone from writes', () => {
        // The managed list only ever governed the project-less path, which no
        // longer exists. `TIMESHEET_GENERAL_CATEGORIES` still groups the rows
        // that already carry one.
        const parsed = createTimesheetBodySchema.safeParse({
            ...base,
            project_id: projectId,
            general_category: 'Standup',
        });
        expect(parsed.success).toBe(true);
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

    it('allows clearing the project — the service re-checks the pair', () => {
        // Legal only if a category survives, which depends on the stored row;
        // `updateEntry` decides that, not the schema.
        expect(patchTimesheetBodySchema.safeParse({ project_id: null }).success).toBe(true);
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

import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROLES } from '../constants/roles.js';
import { TIMESHEET_ENTRY_TYPES } from '../constants/timesheet.js';

/**
 * Bulk timesheet import — resolution and validation.
 *
 * The property that matters most here is PREVIEW/COMMIT AGREEMENT: a row the
 * preview calls `ok` must import, and a row it blocks must not. Both paths
 * run the same `validateImportRows`, and these tests exist to keep it that
 * way — a preview that disagrees with the commit is a preview that lies.
 */

const { projectFindMock, taskFindMock, entryFindMock, buildFilterMock } = vi.hoisted(() => ({
    projectFindMock: vi.fn(),
    taskFindMock: vi.fn(),
    entryFindMock: vi.fn(),
    buildFilterMock: vi.fn(),
}));

vi.mock('../models/project.model.js', () => ({ Project: { find: projectFindMock } }));
vi.mock('../models/task.model.js', () => ({ Task: { find: taskFindMock } }));
vi.mock('../models/timesheet-entry.model.js', () => ({ TimesheetEntry: { find: entryFindMock } }));
vi.mock('./project.service.js', () => ({ buildProjectVisibilityFilter: buildFilterMock }));

// The soft policies come from `timesheet.service` so the preview warns about
// exactly what a single-entry create warns about.
vi.mock('./timesheet.service.js', () => ({
    loadPolicy: vi.fn(async () => ({ selfEditWindowDays: 7, dailyWarnThresholdHours: 8 })),
    sumDailyTotalMinutes: vi.fn(async () => 0),
    overlapsApprovedLeave: vi.fn(async () => false),
    exceedsDailyThreshold: (total: number, hours: number) => total > hours * 60,
    createEntry: vi.fn(async () => ({ data: {}, warnings: {} })),
}));

const svc = await import('./timesheet-import.service.js');

const PROJECT_A = new Types.ObjectId();
const PROJECT_B = new Types.ObjectId();
const PROJECT_DUP = new Types.ObjectId();
const TASK = new Types.ObjectId();

const caller = { id: new Types.ObjectId(), role: ROLES.EMPLOYEE };

/** Yesterday, so nothing trips the no-future-dates rule by accident. */
const past = (() => {
    const d = new Date(Date.now() - 86_400_000);
    return d.toISOString().slice(0, 10);
})();

const lean = (rows: unknown[]) => ({ select: () => ({ lean: async () => rows }) });

const row = (over: Record<string, unknown> = {}) => ({
    row_number: 1,
    date: past,
    project: 'NMF',
    ticket: null,
    context: null,
    billable: 2,
    non_billable: 0,
    notes: 'Did the thing',
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    buildFilterMock.mockReturnValue({});
    projectFindMock.mockReturnValue(
        lean([
            { _id: PROJECT_A, code: 'NMF', name: 'Nordmark Fleet' },
            { _id: PROJECT_B, code: 'AUR', name: 'Aurora Foods' },
            // Two projects sharing a NAME — the real shape of the live data,
            // and the reason a name alone cannot be the identifier.
            { _id: PROJECT_DUP, code: 'TEM', name: 'Template-1' },
            { _id: new Types.ObjectId(), code: 'TEM2', name: 'Template-1' },
        ])
    );
    taskFindMock.mockReturnValue(lean([{ _id: TASK, task_number: 142, project_id: PROJECT_A }]));
    entryFindMock.mockReturnValue(lean([]));
});

describe('validateImportRows — project resolution', () => {
    it('resolves a project by its code', async () => {
        const out = await svc.validateImportRows([row()], caller as never);
        expect(out.rows[0]!.ok).toBe(true);
        expect(out.rows[0]!.resolved?.project_id).toStrictEqual(PROJECT_A);
    });

    it('resolves a code case-insensitively', async () => {
        const out = await svc.validateImportRows([row({ project: 'nmf' })], caller as never);
        expect(out.rows[0]!.ok).toBe(true);
    });

    it('resolves an unambiguous name', async () => {
        const out = await svc.validateImportRows([row({ project: 'Aurora Foods' })], caller as never);
        expect(out.rows[0]!.resolved?.project_id).toStrictEqual(PROJECT_B);
    });

    it('BLOCKS an ambiguous name and names the candidate codes', async () => {
        const out = await svc.validateImportRows([row({ project: 'Template-1' })], caller as never);
        expect(out.rows[0]!.ok).toBe(false);
        // Naming the codes is the whole point — "ambiguous" alone leaves the
        // user with no way to fix the row.
        expect(out.rows[0]!.reason).toMatch(/TEM/);
        expect(out.rows[0]!.reason).toMatch(/TEM2/);
    });

    it('blocks an unknown project', async () => {
        const out = await svc.validateImportRows([row({ project: 'Nordmrk' })], caller as never);
        expect(out.rows[0]!.ok).toBe(false);
        expect(out.rows[0]!.reason).toMatch(/Nordmrk/);
    });

    it('only ever considers projects the caller can see', async () => {
        await svc.validateImportRows([row()], caller as never);
        // The visibility filter is the authorization boundary — a project the
        // caller cannot open must not be resolvable by typing its code.
        expect(buildFilterMock).toHaveBeenCalledWith(caller);
    });
});

describe('validateImportRows — tickets', () => {
    it('resolves a ticket key to a task and marks the row task-linked', async () => {
        const out = await svc.validateImportRows([row({ ticket: 'NMF-142' })], caller as never);
        expect(out.rows[0]!.ok).toBe(true);
        expect(out.rows[0]!.resolved?.task_id).toStrictEqual(TASK);
        expect(out.rows[0]!.resolved?.entry_type).toBe(TIMESHEET_ENTRY_TYPES.TASK_LINKED);
    });

    it('a row without a ticket is a general entry', async () => {
        const out = await svc.validateImportRows([row()], caller as never);
        expect(out.rows[0]!.resolved?.entry_type).toBe(TIMESHEET_ENTRY_TYPES.GENERAL);
        expect(out.rows[0]!.resolved?.task_id).toBeNull();
    });

    it('blocks a ticket belonging to a DIFFERENT project than the row names', async () => {
        // The sheet says AUR but the ticket is NMF's — logging it would
        // attribute the hours to the wrong project.
        const out = await svc.validateImportRows([row({ project: 'AUR', ticket: 'NMF-142' })], caller as never);
        expect(out.rows[0]!.ok).toBe(false);
        expect(out.rows[0]!.reason).toMatch(/NMF-142/);
    });

    it('blocks an unknown ticket number', async () => {
        const out = await svc.validateImportRows([row({ ticket: 'NMF-999' })], caller as never);
        expect(out.rows[0]!.ok).toBe(false);
    });

    it('finds a ticket on a project that has no code', async () => {
        // The ticket lookup once scoped to projects indexed BY CODE, so a
        // code-less project referenced by name could never resolve a ticket.
        // Every project has a code today, which is exactly why this needs a
        // test rather than a reader noticing.
        const codeless = new Types.ObjectId();
        projectFindMock.mockReturnValue(lean([{ _id: codeless, code: '', name: 'Skunkworks' }]));
        taskFindMock.mockReturnValue(lean([{ _id: TASK, task_number: 7, project_id: codeless }]));

        const out = await svc.validateImportRows([row({ project: 'Skunkworks', ticket: 'X-7' })], caller as never);
        expect(out.rows[0]!.ok).toBe(true);
        expect(out.rows[0]!.resolved?.task_id).toStrictEqual(TASK);
    });

    it('blocks a malformed ticket key', async () => {
        const out = await svc.validateImportRows([row({ ticket: 'not-a-key' })], caller as never);
        expect(out.rows[0]!.ok).toBe(false);
    });

    it('drops context on a ticket row rather than sending both', async () => {
        // The validator's discriminated union refuses general_category on a
        // task_linked entry, so carrying it through would fail at write time.
        const out = await svc.validateImportRows([row({ ticket: 'NMF-142', context: 'Standup' })], caller as never);
        expect(out.rows[0]!.ok).toBe(true);
        expect(out.rows[0]!.resolved?.general_category).toBeNull();
    });
});

describe('validateImportRows — row rules', () => {
    it('blocks a future date', async () => {
        const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        const out = await svc.validateImportRows([row({ date: tomorrow })], caller as never);
        expect(out.rows[0]!.ok).toBe(false);
        expect(out.rows[0]!.reason).toMatch(/future/i);
    });

    it('blocks a row with no time on either side', async () => {
        const out = await svc.validateImportRows([row({ billable: 0, non_billable: 0 })], caller as never);
        expect(out.rows[0]!.ok).toBe(false);
    });

    it('blocks a single row over 24 hours', async () => {
        const out = await svc.validateImportRows([row({ billable: 20, non_billable: 8 })], caller as never);
        expect(out.rows[0]!.ok).toBe(false);
    });

    it('converts decimal hours to whole hours + minutes', async () => {
        const out = await svc.validateImportRows([row({ billable: 3.5 })], caller as never);
        expect(out.rows[0]!.resolved).toMatchObject({ billable_hours: 3, billable_minutes: 30 });
    });

    it('rounds to the nearest minute rather than dropping the remainder', async () => {
        const out = await svc.validateImportRows([row({ billable: 1.33 })], caller as never);
        expect(out.rows[0]!.resolved).toMatchObject({ billable_hours: 1, billable_minutes: 20 });
    });

    it('reports the row_number from the FILE, not the index in the array', async () => {
        const out = await svc.validateImportRows([row({ row_number: 7, project: 'Nordmrk' })], caller as never);
        // "row 1 is invalid" would send the user to the wrong line of the sheet.
        expect(out.rows[0]!.row_number).toBe(7);
    });

    it('validates every row, not just up to the first failure', async () => {
        const out = await svc.validateImportRows(
            [row({ row_number: 1, project: 'Nope' }), row({ row_number: 2, billable: 0, non_billable: 0 })],
            caller as never
        );
        // Reporting one error per upload turns fixing a sheet into a
        // guessing game.
        expect(out.rows.filter((r) => !r.ok)).toHaveLength(2);
    });
});

describe('previewImport', () => {
    it('reports dates that already have time logged, with the existing total', async () => {
        entryFindMock.mockReturnValue(
            lean([
                { local_date: past, total_minutes: 480 },
                { local_date: past, total_minutes: 60 },
            ])
        );
        const out = await svc.previewImport([row()], caller as never);
        const collision = out.collisions.find((c) => c.date === past);
        expect(collision).toBeDefined();
        expect(collision!.existing_minutes).toBe(540);
        expect(collision!.existing_entries).toBe(2);
    });

    it('says nothing about a date with no existing entries', async () => {
        const out = await svc.previewImport([row()], caller as never);
        expect(out.collisions).toHaveLength(0);
    });

    it('warns when a day total across the FILE exceeds the threshold', async () => {
        // Three 4h rows on one date is 12h — no single row breaks any rule,
        // and nothing on the single-entry path would ever catch it.
        const rows = [1, 2, 3].map((n) => row({ row_number: n, billable: 4 }));
        const out = await svc.previewImport(rows, caller as never);
        expect(out.warnings.some((w) => w.date === past && /threshold/i.test(w.reason))).toBe(true);
    });

    it('counts existing logged time toward that day warning', async () => {
        entryFindMock.mockReturnValue(lean([{ local_date: past, total_minutes: 420 }]));
        const out = await svc.previewImport([row({ billable: 2 })], caller as never);
        // 7h already + 2h imported = 9h, over the 8h threshold, even though
        // neither the file nor the day alone would trip it.
        expect(out.warnings.some((w) => w.date === past)).toBe(true);
    });

    it('totals only the rows that would actually import', async () => {
        const rows = [row({ row_number: 1, billable: 2 }), row({ row_number: 2, project: 'Nope', billable: 5 })];
        const out = await svc.previewImport(rows, caller as never);
        expect(out.summary.ok_rows).toBe(1);
        expect(out.summary.blocked_rows).toBe(1);
        expect(out.summary.billable_minutes).toBe(120);
    });
});

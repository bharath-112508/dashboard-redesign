import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `timesheet.service` (Step 23).
 *
 * Coverage focus:
 *   1. `createEntry` — future-date guard, zero-duration guard, task
 *      visibility delegation, project-id mismatch detection,
 *      `warning.exceeds_daily_threshold` set when sum > threshold,
 *      `warning.overlaps_approved_leave` set when an approved leave
 *      covers the date.
 *   2. `patchEntry` — non-owner non-admin rejected, owner-out-of-window
 *      rejected (TIMESHEET_EDIT_WINDOW_EXPIRED), admin-out-of-window
 *      allowed AND emits a second `timesheet.edit_out_of_window` audit
 *      row, zero-duration after patch rejected.
 *   3. `deleteEntry` — same gates as patch.
 *   4. `listMyEntries` — ignores `user_id` query (caller scope only).
 *   5. `listAllEntries` — team-tier read (admin/manager/team_lead), employees 403.
 *   6. `summary` — team-tier read (admin/manager/team_lead), group_by translation.
 */

const {
    entryCreateMock,
    entryFindByIdMock,
    entryFindMock,
    entryCountMock,
    entryAggregateMock,
    entryDistinctMock,
    taskFindByIdMock,
    taskFindMock,
    leaveExistsMock,
    loadProjectForCallerMock,
    recordAuditMock,
    getOrInitSettingsMock,
} = vi.hoisted(() => ({
    entryCreateMock: vi.fn(),
    entryFindByIdMock: vi.fn(),
    entryFindMock: vi.fn(),
    entryCountMock: vi.fn(),
    entryAggregateMock: vi.fn(),
    entryDistinctMock: vi.fn(),
    taskFindByIdMock: vi.fn(),
    taskFindMock: vi.fn(),
    leaveExistsMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    recordAuditMock: vi.fn(),
    getOrInitSettingsMock: vi.fn(),
}));

vi.mock('../models/timesheet-entry.model.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../models/timesheet-entry.model.js')>();
    return {
        ...actual,
        TimesheetEntry: {
            create: entryCreateMock,
            findById: entryFindByIdMock,
            find: entryFindMock,
            countDocuments: entryCountMock,
            aggregate: entryAggregateMock,
            distinct: entryDistinctMock,
        },
    };
});

vi.mock('../models/task.model.js', () => ({
    Task: { findById: taskFindByIdMock, find: taskFindMock },
}));

vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: { exists: leaveExistsMock },
}));

vi.mock('./project.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./project.service.js')>();
    return {
        ...actual,
        loadProjectForCaller: loadProjectForCallerMock,
    };
});

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: getOrInitSettingsMock,
}));

// User model — only needed for reporting-chain scoping (directReportIdsOf).
const userFindMock = vi.hoisted(() => vi.fn());
vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock, findById: vi.fn() },
}));
/** Stub `User.find(...).distinct('_id')` → the given direct-report ids. */
const stubReports = (ids: unknown[]) => userFindMock.mockReturnValue({ distinct: () => Promise.resolve(ids) });

const svc = await import('./timesheet.service.js');
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { ROLES } from '../constants/roles.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const today = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
const daysAgo = (n: number): string => dayjs().tz(DEFAULT_TIMEZONE).subtract(n, 'day').format(DATE_FORMAT);

const adminCaller = () => ({ id: new Types.ObjectId(), role: ROLES.ADMIN, audit: undefined });
// `system-role-definitions.ts` puts `timesheet.edit_out_of_window` in the
// Manager bundle, so a real manager's token carries it. The fixture models
// the permission list now that the service checks the permission rather than
// the role — see `managerCallerWithoutOverride` for the other half.
const managerCaller = () => ({
    id: new Types.ObjectId(),
    role: ROLES.MANAGER,
    permissions: [PERMISSIONS.TIMESHEET_EDIT_OUT_OF_WINDOW],
    audit: undefined,
});
const managerCallerWithoutOverride = () => ({
    id: new Types.ObjectId(),
    role: ROLES.MANAGER,
    permissions: [],
    audit: undefined,
});
const teamLeadCaller = () => ({ id: new Types.ObjectId(), role: ROLES.TEAM_LEAD, audit: undefined });
const employeeCaller = (id?: Types.ObjectId) => ({
    id: id ?? new Types.ObjectId(),
    role: ROLES.EMPLOYEE,
    audit: undefined,
});

const defaultSettings = (overrides: Record<string, unknown> = {}) => ({
    timesheet: {
        self_edit_window_days: 7,
        daily_warn_threshold_hours: 8,
        ...overrides,
    },
});

const stubTaskLookup = (
    task: { _id: Types.ObjectId; project_id: Types.ObjectId; sprint_id: Types.ObjectId | null } | null
): void => {
    taskFindByIdMock.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(task) }),
    });
};

const stubAggregate = (total: number): void => {
    entryAggregateMock.mockResolvedValueOnce(total > 0 ? [{ total }] : []);
};

const makeEntry = (overrides: Record<string, unknown> = {}) => {
    const e = {
        _id: new Types.ObjectId(),
        user_id: new Types.ObjectId(),
        local_date: daysAgo(1),
        entry_type: 'task_linked' as 'task_linked' | 'general',
        project_id: new Types.ObjectId(),
        sprint_id: null as Types.ObjectId | null,
        task_id: new Types.ObjectId(),
        general_category: null as string | null,
        billable_hours: 1,
        billable_minutes: 0,
        non_billable_hours: 0,
        non_billable_minutes: 0,
        billable_total_minutes: 60,
        non_billable_total_minutes: 0,
        idle_hours: 0,
        idle_minutes: 0,
        idle_total_minutes: 0,
        total_minutes: 60,
        description: 'work',
        last_edited_by: new Types.ObjectId(),
        last_edited_at: new Date(),
        save: vi.fn(),
        deleteOne: vi.fn(),
        toJSON: vi.fn(),
        ...overrides,
    };
    e.save.mockImplementation(async () => e);
    e.deleteOne.mockImplementation(async () => undefined);
    e.toJSON.mockImplementation(() => ({
        id: e._id.toString(),
        user_id: e.user_id.toString(),
        local_date: e.local_date,
        entry_type: e.entry_type,
        total_minutes: e.total_minutes,
    }));
    return e;
};

beforeEach(() => {
    vi.resetAllMocks();
    getOrInitSettingsMock.mockResolvedValue(defaultSettings());
    leaveExistsMock.mockResolvedValue(null);
    entryAggregateMock.mockResolvedValue([]);
});

// ─── createEntry ─────────────────────────────────────────────────────────

describe('createEntry', () => {
    const baseTaskLinkedBody = (overrides: Record<string, unknown> = {}) => ({
        local_date: today(),
        entry_type: 'task_linked' as const,
        project_id: new Types.ObjectId().toString(),
        sprint_id: null,
        task_id: new Types.ObjectId().toString(),
        general_category: null,
        billable_hours: 2,
        billable_minutes: 0,
        non_billable_hours: 0,
        non_billable_minutes: 0,
        idle_hours: 0,
        idle_minutes: 0,
        description: 'work',
        ...overrides,
    });

    it('rejects future local_date with TIMESHEET_FUTURE_DATE', async () => {
        const future = dayjs().tz(DEFAULT_TIMEZONE).add(1, 'day').format(DATE_FORMAT);
        await expect(
            svc.createEntry(baseTaskLinkedBody({ local_date: future }), employeeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TIMESHEET_FUTURE_DATE });
        expect(entryCreateMock).not.toHaveBeenCalled();
    });

    it('rejects a single entry that exceeds the 24h hard cap (regression — combined billable+non-billable)', async () => {
        // Each `*_hours` field caps at 24 and `*_minutes` at 59 in the
        // model; without the per-row guard a single entry could encode
        // 24h59m + 24h59m ≈ 50h on a single date. The guard refuses
        // anything > 24*60 minutes.
        await expect(
            svc.createEntry(
                baseTaskLinkedBody({
                    billable_hours: 20,
                    billable_minutes: 0,
                    non_billable_hours: 6,
                    non_billable_minutes: 0,
                }),
                employeeCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.TIMESHEET_DURATION_TOO_LARGE });
        expect(entryCreateMock).not.toHaveBeenCalled();
    });

    it('rejects when both billable and non-billable are zero', async () => {
        await expect(
            svc.createEntry(
                baseTaskLinkedBody({
                    billable_hours: 0,
                    billable_minutes: 0,
                    non_billable_hours: 0,
                    non_billable_minutes: 0,
                }),
                employeeCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.TIMESHEET_ZERO_DURATION });
    });

    it('rejects when body project_id does not match the task parent project', async () => {
        const projectA = new Types.ObjectId();
        const projectB = new Types.ObjectId();
        const taskId = new Types.ObjectId();
        const body = baseTaskLinkedBody({ project_id: projectB.toString(), task_id: taskId.toString() });

        stubTaskLookup({ _id: taskId, project_id: projectA, sprint_id: null });
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: projectA });

        await expect(svc.createEntry(body, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TIMESHEET_TASK_REQUIRED,
        });
    });

    it('persists the row and surfaces exceeds_daily_threshold + overlaps_approved_leave warnings', async () => {
        const projectId = new Types.ObjectId();
        const taskId = new Types.ObjectId();
        stubTaskLookup({ _id: taskId, project_id: projectId, sprint_id: null });
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: projectId });
        const created = makeEntry({ project_id: projectId, task_id: taskId, total_minutes: 9 * 60 });
        entryCreateMock.mockResolvedValueOnce(created);
        stubAggregate(9 * 60); // > 8h threshold
        leaveExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });

        const result = await svc.createEntry(
            {
                ...baseTaskLinkedBody({
                    project_id: projectId.toString(),
                    task_id: taskId.toString(),
                    billable_hours: 9,
                    billable_minutes: 0,
                }),
            },
            employeeCaller()
        );

        expect(result.warnings.exceeds_daily_threshold).toBe(true);
        expect(result.warnings.overlaps_approved_leave).toBe(true);
        expect(entryCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                project_id: projectId,
                task_id: taskId,
                total_minutes: 9 * 60,
            })
        );
    });

    it('does not flag overlaps_approved_leave when no leave covers the date', async () => {
        const projectId = new Types.ObjectId();
        const taskId = new Types.ObjectId();
        stubTaskLookup({ _id: taskId, project_id: projectId, sprint_id: null });
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: projectId });
        entryCreateMock.mockResolvedValueOnce(makeEntry({ project_id: projectId, task_id: taskId, total_minutes: 60 }));
        stubAggregate(60);
        leaveExistsMock.mockResolvedValueOnce(null);

        const result = await svc.createEntry(
            baseTaskLinkedBody({ project_id: projectId.toString(), task_id: taskId.toString() }),
            employeeCaller()
        );

        expect(result.warnings.exceeds_daily_threshold).toBe(false);
        expect(result.warnings.overlaps_approved_leave).toBe(false);
    });

    it('accepts a general entry without task_id and persists general_category', async () => {
        const projectId = new Types.ObjectId();
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: projectId });
        entryCreateMock.mockResolvedValueOnce(makeEntry({ entry_type: 'general' }));
        stubAggregate(60);

        await svc.createEntry(
            {
                local_date: today(),
                entry_type: 'general',
                project_id: projectId.toString(),
                sprint_id: null,
                task_id: null,
                general_category: 'meeting',
                billable_hours: 1,
                billable_minutes: 0,
                non_billable_hours: 0,
                non_billable_minutes: 0,
                idle_hours: 0,
                idle_minutes: 0,
                description: '',
            },
            employeeCaller()
        );

        expect(entryCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({ entry_type: 'general', general_category: 'meeting' })
        );
        expect(taskFindByIdMock).not.toHaveBeenCalled();
    });

    // The project is what a general entry is attributed to, so it goes through
    // the same visibility check as a task-linked one — a caller can't park
    // internal time on a project they can't see.
    it('scope-checks the project on a general entry', async () => {
        const projectId = new Types.ObjectId();
        loadProjectForCallerMock.mockRejectedValueOnce(AppError.notFound('Project not found'));

        await expect(
            svc.createEntry(
                {
                    local_date: today(),
                    entry_type: 'general',
                    project_id: projectId.toString(),
                    sprint_id: null,
                    task_id: null,
                    general_category: 'meeting',
                    billable_hours: 1,
                    billable_minutes: 0,
                    non_billable_hours: 0,
                    non_billable_minutes: 0,
                    idle_hours: 0,
                    idle_minutes: 0,
                    description: 'Weekly sync',
                },
                employeeCaller()
            )
        ).rejects.toThrow('Project not found');

        expect(entryCreateMock).not.toHaveBeenCalled();
    });

    it('rolls idle time into the persisted totals (idle_total_minutes + total_minutes)', async () => {
        const projectId = new Types.ObjectId();
        const taskId = new Types.ObjectId();
        stubTaskLookup({ _id: taskId, project_id: projectId, sprint_id: null });
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: projectId });
        entryCreateMock.mockResolvedValueOnce(makeEntry({ project_id: projectId, task_id: taskId }));
        stubAggregate(150);

        await svc.createEntry(
            baseTaskLinkedBody({
                project_id: projectId.toString(),
                task_id: taskId.toString(),
                billable_hours: 1, // 60
                billable_minutes: 0,
                non_billable_hours: 0,
                non_billable_minutes: 30, // 30
                idle_hours: 1, // 60
                idle_minutes: 0,
            }),
            employeeCaller()
        );

        expect(entryCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                idle_hours: 1,
                idle_minutes: 0,
                idle_total_minutes: 60,
                total_minutes: 150,
            })
        );
    });
});

// ─── patchEntry ──────────────────────────────────────────────────────────

describe('patchEntry', () => {
    it('rejects a non-owner non-privileged caller', async () => {
        const entry = makeEntry();
        entryFindByIdMock.mockResolvedValueOnce(entry);
        await expect(svc.patchEntry(entry._id, { billable_hours: 2 }, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('rejects an owner editing outside the self-edit window with TIMESHEET_EDIT_WINDOW_EXPIRED', async () => {
        const owner = new Types.ObjectId();
        const entry = makeEntry({ user_id: owner, local_date: daysAgo(30) });
        entryFindByIdMock.mockResolvedValueOnce(entry);

        await expect(svc.patchEntry(entry._id, { billable_hours: 2 }, employeeCaller(owner))).rejects.toMatchObject({
            code: ERROR_CODES.TIMESHEET_EDIT_WINDOW_EXPIRED,
        });
        expect(entry.save).not.toHaveBeenCalled();
    });

    it('allows admin to edit out-of-window AND emits the timesheet.edit_out_of_window audit row', async () => {
        const admin = {
            id: new Types.ObjectId(),
            role: ROLES.ADMIN,
            audit: { actor_id: new Types.ObjectId(), actor_role: ROLES.ADMIN, ip: null, user_agent: null },
        };
        const entry = makeEntry({ local_date: daysAgo(30) });
        entryFindByIdMock.mockResolvedValueOnce(entry);
        stubAggregate(120);
        leaveExistsMock.mockResolvedValueOnce(null);

        await svc.patchEntry(entry._id, { billable_hours: 2, billable_minutes: 0 }, admin);

        expect(entry.save).toHaveBeenCalledTimes(1);
        const auditActions = recordAuditMock.mock.calls.map((c) => (c[1] as { action: string }).action);
        expect(auditActions).toContain('timesheet.update');
        expect(auditActions).toContain('timesheet.edit_out_of_window');
    });

    it('rejects a patch that zeroes both billable and non-billable splits', async () => {
        const owner = new Types.ObjectId();
        const entry = makeEntry({ user_id: owner, local_date: daysAgo(1) });
        entryFindByIdMock.mockResolvedValueOnce(entry);

        await expect(
            svc.patchEntry(
                entry._id,
                {
                    billable_hours: 0,
                    billable_minutes: 0,
                    non_billable_hours: 0,
                    non_billable_minutes: 0,
                },
                employeeCaller(owner)
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.TIMESHEET_ZERO_DURATION });
    });

    it('rebinds task_id, project_id, and sprint_id when patching to a different task on a task_linked entry', async () => {
        const owner = new Types.ObjectId();
        const oldProject = new Types.ObjectId();
        const oldTask = new Types.ObjectId();
        const newProject = new Types.ObjectId();
        const newTask = new Types.ObjectId();
        const newSprint = new Types.ObjectId();
        const entry = makeEntry({
            user_id: owner,
            local_date: daysAgo(1),
            entry_type: 'task_linked',
            project_id: oldProject,
            task_id: oldTask,
            sprint_id: null,
        });
        entryFindByIdMock.mockResolvedValueOnce(entry);
        stubTaskLookup({ _id: newTask, project_id: newProject, sprint_id: newSprint });
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: newProject });
        stubAggregate(60);
        leaveExistsMock.mockResolvedValueOnce(null);

        await svc.patchEntry(entry._id, { task_id: newTask.toString() }, employeeCaller(owner));

        expect(entry.task_id).toEqual(newTask);
        expect(entry.project_id).toEqual(newProject);
        // Sprint defaults to the new task's current sprint when caller doesn't pass one.
        expect(entry.sprint_id).toEqual(newSprint);
    });

    it('rejects a patch that would push the entry past the 24h per-row cap', async () => {
        const owner = new Types.ObjectId();
        const entry = makeEntry({
            user_id: owner,
            local_date: daysAgo(1),
            billable_hours: 12,
            billable_minutes: 0,
            non_billable_hours: 0,
            non_billable_minutes: 0,
        });
        entryFindByIdMock.mockResolvedValueOnce(entry);

        await expect(
            svc.patchEntry(entry._id, { non_billable_hours: 20, non_billable_minutes: 0 }, employeeCaller(owner))
        ).rejects.toMatchObject({ code: ERROR_CODES.TIMESHEET_DURATION_TOO_LARGE });
        expect(entry.save).not.toHaveBeenCalled();
    });

    it('recomputes the derived totals after patching duration fields', async () => {
        const owner = new Types.ObjectId();
        const entry = makeEntry({ user_id: owner, local_date: daysAgo(1) });
        entryFindByIdMock.mockResolvedValueOnce(entry);
        stubAggregate(180);
        leaveExistsMock.mockResolvedValueOnce(null);

        await svc.patchEntry(entry._id, { billable_hours: 2, billable_minutes: 30 }, employeeCaller(owner));

        expect(entry.billable_total_minutes).toBe(150);
        expect(entry.total_minutes).toBe(150);
    });
});

// ─── deleteEntry ─────────────────────────────────────────────────────────

describe('deleteEntry', () => {
    it('rejects an owner deleting outside the self-edit window', async () => {
        const owner = new Types.ObjectId();
        const entry = makeEntry({ user_id: owner, local_date: daysAgo(30) });
        entryFindByIdMock.mockResolvedValueOnce(entry);
        await expect(svc.deleteEntry(entry._id, employeeCaller(owner))).rejects.toMatchObject({
            code: ERROR_CODES.TIMESHEET_EDIT_WINDOW_EXPIRED,
        });
        expect(entry.deleteOne).not.toHaveBeenCalled();
    });

    it('allows owner-in-window delete', async () => {
        const owner = new Types.ObjectId();
        const entry = makeEntry({ user_id: owner, local_date: daysAgo(2) });
        entryFindByIdMock.mockResolvedValueOnce(entry);
        await expect(svc.deleteEntry(entry._id, employeeCaller(owner))).resolves.toEqual({ deleted: true });
        expect(entry.deleteOne).toHaveBeenCalledTimes(1);
    });

    it('allows manager to delete out-of-window entries', async () => {
        const entry = makeEntry({ local_date: daysAgo(30) });
        entryFindByIdMock.mockResolvedValueOnce(entry);
        await expect(svc.deleteEntry(entry._id, managerCaller())).resolves.toEqual({ deleted: true });
    });

    it('refuses an out-of-window delete by a manager without the override permission', async () => {
        // The role used to be the whole check, so `timesheet.edit_out_of_window`
        // conferred nothing. Strip it and the override must fail.
        const entry = makeEntry({ local_date: daysAgo(30) });
        entryFindByIdMock.mockResolvedValueOnce(entry);
        await expect(svc.deleteEntry(entry._id, managerCallerWithoutOverride())).rejects.toMatchObject({
            code: ERROR_CODES.TIMESHEET_EDIT_WINDOW_EXPIRED,
        });
        expect(entry.deleteOne).not.toHaveBeenCalled();
    });
});

// ─── listMyEntries / listAllEntries / summary RBAC ───────────────────────

describe('list & summary RBAC', () => {
    const stubFind = (rows: ReturnType<typeof makeEntry>[]): void => {
        entryFindMock.mockReturnValueOnce({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve(rows),
                }),
            }),
        });
        entryCountMock.mockResolvedValueOnce(rows.length);
    };

    it('listMyEntries scopes to caller.id even if user_id is passed in the query', async () => {
        stubFind([]);
        const caller = employeeCaller();
        await svc.listMyEntries({ user_id: new Types.ObjectId().toString(), page: 1, limit: 20 }, caller);
        expect(entryFindMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: caller.id }));
    });

    it('listAllEntries rejects an employee caller with FORBIDDEN', async () => {
        await expect(svc.listAllEntries({ page: 1, limit: 20 }, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('summary rejects an employee caller', async () => {
        await expect(svc.summary({ group_by: 'project' }, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('listAllEntries allows a team lead (holds timesheet.read — matches the route gate)', async () => {
        stubReports([]);
        stubFind([]);
        await expect(svc.listAllEntries({ page: 1, limit: 20 }, teamLeadCaller())).resolves.toMatchObject({
            data: [],
        });
    });

    it('listAllEntries scopes a manager to ONLY their direct reports', async () => {
        const reports = [new Types.ObjectId(), new Types.ObjectId()];
        stubReports(reports);
        let filter: Record<string, unknown> = {};
        entryFindMock.mockImplementation((f: Record<string, unknown>) => {
            filter = f;
            return { sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }) };
        });
        entryCountMock.mockResolvedValue(0);

        await svc.listAllEntries({ page: 1, limit: 20 }, managerCaller());
        expect(filter.user_id).toEqual({ $in: reports });
    });

    it('listAllEntries lets an ADMIN see everyone (no user_id restriction)', async () => {
        let filter: Record<string, unknown> = {};
        entryFindMock.mockImplementation((f: Record<string, unknown>) => {
            filter = f;
            return { sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }) };
        });
        entryCountMock.mockResolvedValue(0);

        await svc.listAllEntries({ page: 1, limit: 20 }, adminCaller());
        expect(filter.user_id).toBeUndefined();
    });

    it('summary allows a team lead', async () => {
        stubReports([]);
        entryAggregateMock.mockResolvedValueOnce([]);
        await expect(svc.summary({ group_by: 'project' }, teamLeadCaller())).resolves.toEqual([]);
    });

    // ─── `summary` row scoping for INTERNAL callers ──────────────────────
    //
    // This endpoint had none, so a Team Lead whose `listAllEntries` returned
    // nothing still got every employee's totals from here. The two now agree.

    const summaryMatch = () => {
        const pipeline = entryAggregateMock.mock.calls.at(-1)![0] as Array<Record<string, unknown>>;
        return (pipeline.find((st) => '$match' in st) as { $match: Record<string, unknown> }).$match;
    };

    it('summary scopes a manager to their direct reports, exactly as the list does', async () => {
        const reports = [new Types.ObjectId(), new Types.ObjectId()];
        stubReports(reports);
        entryAggregateMock.mockResolvedValueOnce([]);

        await svc.summary({ group_by: 'user' }, managerCaller());
        expect(summaryMatch().user_id).toEqual({ $in: reports });
    });

    it('summary leaves an ADMIN unscoped', async () => {
        entryAggregateMock.mockResolvedValueOnce([]);
        await svc.summary({ group_by: 'user' }, adminCaller());
        expect(summaryMatch().user_id).toBeUndefined();
    });

    it('summary scopes by PROJECT, not the reporting chain, when a project is named', async () => {
        // The project Timesheet tab. A project total that silently omitted
        // non-reports would be a wrong number, not a filtered one — so the
        // project is the boundary and `loadProjectForCaller` is the gate.
        const project_id = new Types.ObjectId().toString();
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: new Types.ObjectId(project_id) });
        entryAggregateMock.mockResolvedValueOnce([]);

        await svc.summary({ group_by: 'user', project_id }, teamLeadCaller());

        expect(loadProjectForCallerMock).toHaveBeenCalled();
        expect(summaryMatch().user_id).toBeUndefined();
    });

    it('summary refuses a team lead a project they cannot open', async () => {
        loadProjectForCallerMock.mockRejectedValueOnce(new Error('no access'));
        await expect(
            svc.summary({ group_by: 'user', project_id: new Types.ObjectId().toString() }, teamLeadCaller())
        ).rejects.toThrow();
        expect(entryAggregateMock).not.toHaveBeenCalled();
    });

    const clientCaller = () => ({ id: new Types.ObjectId(), role: ROLES.CLIENT, audit: undefined });

    // ─── Client-side slice of `summary` ─────────────────────────────────
    //
    // The endpoint has no row scoping of its own — it trusts the `project_id`
    // it is handed — so every one of these is load-bearing, not cosmetic.

    it('listAllEntries applies the same client scoping as summary', async () => {
        await expect(svc.listAllEntries({ page: 1, limit: 20 }, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('listAllEntries gives a client billable rows with the task and notes, and no person', async () => {
        const project_id = new Types.ObjectId().toString();
        const taskId = new Types.ObjectId();
        const authorId = new Types.ObjectId();
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: new Types.ObjectId(project_id) });
        taskFindMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve([{ _id: taskId, title: 'Fix invoice rounding' }]) }),
        });
        userFindMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve([{ _id: authorId, full_name: 'Rohan Iyer' }]) }),
        });

        let filter: Record<string, unknown> = {};
        entryFindMock.mockImplementationOnce((f: Record<string, unknown>) => {
            filter = f;
            return {
                sort: () => ({
                    skip: () => ({
                        limit: () =>
                            Promise.resolve([
                                makeEntry({
                                    user_id: authorId,
                                    task_id: taskId,
                                    project_id: new Types.ObjectId(project_id),
                                    description: 'Pairing session on SEK rounding',
                                    billable_total_minutes: 120,
                                    non_billable_total_minutes: 300,
                                    total_minutes: 420,
                                }),
                            ]),
                    }),
                }),
            };
        });
        entryCountMock.mockResolvedValueOnce(1);

        const res = await svc.listAllEntries({ page: 1, limit: 20, project_id }, clientCaller());

        expect(filter.billable_total_minutes).toEqual({ $gt: 0 });
        const row = res.data[0];
        // What the client is meant to get…
        expect(row.description).toBe('Pairing session on SEK rounding');
        expect(row.task).toMatchObject({ title: 'Fix invoice rounding' });
        expect(row.billable_total_minutes).toBe(120);
        expect(row.user).toMatchObject({ full_name: 'Rohan Iyer' });
        // …and everything the whitelist must still keep out. `user_id` stays
        // off: the hydrated `user` object is the whole of what's needed.
        expect(row.user_id).toBeUndefined();
        expect(row.non_billable_total_minutes).toBeUndefined();
        expect(row.idle_total_minutes).toBeUndefined();
        // Echoing the real total would expose the non-billable difference.
        expect(row.total_minutes).toBe(120);
    });

    it('summary refuses a client with no project_id (would span every project)', async () => {
        await expect(svc.summary({ group_by: 'project' }, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    // Per-person output is deliberately allowed (the client is shown who did
    // the work they are billed for) — but still ONLY inside a project they can
    // open, and still with no non-billable figures attached.
    it('summary gives a client per-person totals, billable-only, for their own project', async () => {
        const project_id = new Types.ObjectId().toString();
        const userId = new Types.ObjectId();
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: new Types.ObjectId(project_id) });
        userFindMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve([{ _id: userId, full_name: 'Rohan Iyer' }]) }),
        });
        entryAggregateMock.mockResolvedValueOnce([
            {
                _id: { user_id: userId },
                billable_total_minutes: 6720,
                non_billable_total_minutes: 900,
                idle_total_minutes: 0,
                total_minutes: 7620,
                entry_count: 14,
            },
        ]);

        const rows = await svc.summary({ group_by: 'user', project_id }, clientCaller());

        expect(rows[0]).toMatchObject({
            billable_total_minutes: 6720,
            total_minutes: 6720,
            user: { full_name: 'Rohan Iyer' },
        });
        expect(rows[0].non_billable_total_minutes).toBeUndefined();
    });

    it('summary still refuses a client a per-person view of a project they cannot open', async () => {
        loadProjectForCallerMock.mockRejectedValueOnce(new Error('no access'));
        await expect(
            svc.summary({ group_by: 'user', project_id: new Types.ObjectId().toString() }, clientCaller())
        ).rejects.toThrow();
        expect(entryAggregateMock).not.toHaveBeenCalled();
    });

    it("summary refuses a client a project they can't open", async () => {
        loadProjectForCallerMock.mockRejectedValueOnce(
            Object.assign(new Error('nope'), { code: ERROR_CODES.PROJECT_NOT_FOUND })
        );
        await expect(
            svc.summary({ group_by: 'date', project_id: new Types.ObjectId().toString() }, clientCaller())
        ).rejects.toThrow();
        expect(entryAggregateMock).not.toHaveBeenCalled();
    });

    it('summary gives a client billable-only rows, matched on billable time only', async () => {
        const project_id = new Types.ObjectId().toString();
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: new Types.ObjectId(project_id) });
        entryAggregateMock.mockResolvedValueOnce([
            {
                _id: { local_date: '2026-08-01' },
                billable_total_minutes: 120,
                non_billable_total_minutes: 300,
                idle_total_minutes: 60,
                total_minutes: 480,
                entry_count: 3,
            },
        ]);

        const rows = await svc.summary({ group_by: 'date', project_id }, clientCaller());

        // Non-billable / idle never leave the API — a field that isn't in the
        // response can't leak through a future component.
        expect(rows[0]).toEqual({
            group_key: { local_date: '2026-08-01' },
            billable_total_minutes: 120,
            total_minutes: 120,
            entry_count: 3,
        });

        const pipeline = entryAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const match = pipeline.find((s) => '$match' in s) as { $match: Record<string, unknown> };
        expect(match.$match.billable_total_minutes).toEqual({ $gt: 0 });
    });

    it('summary builds the correct aggregation $group key for group_by=user', async () => {
        entryAggregateMock.mockResolvedValueOnce([]);
        await svc.summary({ group_by: 'user' }, adminCaller());

        const pipeline = entryAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const groupStage = pipeline.find((s) => '$group' in s);
        expect(groupStage).toEqual(
            expect.objectContaining({
                $group: expect.objectContaining({
                    _id: { user_id: '$user_id' },
                }),
            })
        );
    });
});

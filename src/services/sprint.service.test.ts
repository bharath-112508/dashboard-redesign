import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `sprint.service` (Step 16).
 *
 * Coverage focus:
 *  1. `createSprint` honours the parent project's window (start_date >=
 *     project.start_date; end_date <= project.end_date when set), and is
 *     unrestricted when the project has `end_date = null` (open-ended).
 *  2. `loadProjectForCaller` is delegated through, so a non-member employee
 *     gets 403 before any sprint write happens.
 *  3. Updates re-validate the window after the patch is applied (so a
 *     sprint can't be PATCHed out of bounds).
 *  4. PATCH/DELETE require manager-or-above even though the route gates this —
 *     defence in depth.
 */

const {
    sprintCreateMock,
    sprintFindByIdMock,
    sprintFindMock,
    sprintFindOneMock,
    sprintCountDocumentsMock,
    taskCountDocumentsMock,
    taskUpdateManyMock,
    loadProjectForCallerMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    sprintCreateMock: vi.fn(),
    sprintFindByIdMock: vi.fn(),
    sprintFindMock: vi.fn(),
    sprintFindOneMock: vi.fn(),
    sprintCountDocumentsMock: vi.fn(),
    taskCountDocumentsMock: vi.fn(),
    taskUpdateManyMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/sprint.model.js', () => ({
    Sprint: {
        create: sprintCreateMock,
        findById: sprintFindByIdMock,
        find: sprintFindMock,
        findOne: sprintFindOneMock,
        countDocuments: sprintCountDocumentsMock,
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { findById: vi.fn(), findOne: vi.fn(), find: vi.fn(), countDocuments: vi.fn(), create: vi.fn() },
}));

vi.mock('../models/task.model.js', () => ({
    Task: {
        countDocuments: taskCountDocumentsMock,
        updateMany: taskUpdateManyMock,
    },
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

const svc = await import('./sprint.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';

const adminCaller = () => ({
    id: new Types.ObjectId(),
    role: ROLES.ADMIN,
    audit: undefined,
});

const employeeCaller = () => ({
    id: new Types.ObjectId(),
    role: ROLES.EMPLOYEE,
    audit: undefined,
});

const makeProject = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    ...overrides,
});

const makeSprint = (overrides: Record<string, unknown> = {}) => {
    const sprint = {
        _id: new Types.ObjectId(),
        project_id: new Types.ObjectId(),
        name: 'Sprint 1',
        goal: '',
        start_date: '2026-02-01',
        end_date: '2026-02-14',
        status: 'planned',
        is_archived: false,
        created_by: new Types.ObjectId(),
        save: vi.fn(),
        deleteOne: vi.fn(),
        toJSON() {
            return {
                id: this._id.toString(),
                project_id: this.project_id.toString(),
                name: this.name,
                goal: this.goal,
                start_date: this.start_date,
                end_date: this.end_date,
                status: this.status,
                is_archived: this.is_archived,
            };
        },
        ...overrides,
    };
    sprint.save.mockImplementation(async () => sprint);
    return sprint;
};

beforeEach(() => {
    vi.resetAllMocks();
    // R3 — `deleteSprint` checks `Task.countDocuments({ sprint_id })`
    // before allowing the delete. Default to "no dependants" so the
    // legacy happy-path test continues to pass; tests exercising the
    // dependant-refusal branch override per-call.
    taskCountDocumentsMock.mockResolvedValue(0);
});

// ─── createSprint — window enforcement ───────────────────────────────────

describe('createSprint — project window', () => {
    it('happy path: sprint inside window persists and returns the public doc', async () => {
        const proj = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        const created = makeSprint({ project_id: proj._id });
        sprintCreateMock.mockResolvedValueOnce(created);

        const out = await svc.createSprint(
            proj._id,
            { name: 'Sprint 1', goal: '', start_date: '2026-02-01', end_date: '2026-02-14' },
            adminCaller()
        );

        expect(sprintCreateMock).toHaveBeenCalledTimes(1);
        expect(out).toMatchObject({ name: 'Sprint 1' });
    });

    it('rejects when start_date < project.start_date with SPRINT_DATE_INVALID', async () => {
        const proj = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        await expect(
            svc.createSprint(
                proj._id,
                { name: 'Bad', goal: '', start_date: '2025-12-01', end_date: '2026-02-01' },
                adminCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.SPRINT_DATE_INVALID });
        expect(sprintCreateMock).not.toHaveBeenCalled();
    });

    it('rejects when end_date > project.end_date with SPRINT_DATE_INVALID', async () => {
        const proj = makeProject({ end_date: '2026-06-30' });
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        await expect(
            svc.createSprint(
                proj._id,
                { name: 'Bad', goal: '', start_date: '2026-06-15', end_date: '2026-07-15' },
                adminCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.SPRINT_DATE_INVALID });
    });

    it('open-ended project (end_date=null) accepts any future end_date', async () => {
        const proj = makeProject({ end_date: null });
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        const created = makeSprint({ project_id: proj._id, end_date: '2099-12-31' });
        sprintCreateMock.mockResolvedValueOnce(created);

        const out = await svc.createSprint(
            proj._id,
            { name: 'Open', goal: '', start_date: '2026-02-01', end_date: '2099-12-31' },
            adminCaller()
        );
        expect(out).toMatchObject({ name: 'Sprint 1' });
    });

    it('propagates 403 from loadProjectForCaller for an employee with no access', async () => {
        loadProjectForCallerMock.mockRejectedValueOnce(
            Object.assign(new Error('forbidden'), { code: ERROR_CODES.FORBIDDEN })
        );
        await expect(
            svc.createSprint(
                new Types.ObjectId(),
                { name: 'X', goal: '', start_date: '2026-02-01', end_date: '2026-02-14' },
                employeeCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
        expect(sprintCreateMock).not.toHaveBeenCalled();
    });
});

// ─── updateSprint ────────────────────────────────────────────────────────

describe('updateSprint', () => {
    it('non-manager (employee) is forbidden even if they are a project member', async () => {
        await expect(svc.updateSprint(new Types.ObjectId(), { name: 'X' }, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('rejects PATCHing the sprint outside the project window', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, end_date: '2026-02-14' });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        await expect(svc.updateSprint(sprint._id, { end_date: '2027-01-01' }, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.SPRINT_DATE_INVALID,
        });
        expect(sprint.save).not.toHaveBeenCalled();
    });

    it('happy path saves and returns the new shape', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        const out = await svc.updateSprint(sprint._id, { name: 'Renamed', status: 'active' }, adminCaller());

        expect(sprint.save).toHaveBeenCalled();
        expect(out).toMatchObject({ name: 'Renamed', status: 'active' });
    });
});

// ─── deleteSprint ────────────────────────────────────────────────────────

describe('deleteSprint', () => {
    it('non-manager forbidden', async () => {
        await expect(svc.deleteSprint(new Types.ObjectId(), employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('happy path deletes and audits', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        await svc.deleteSprint(sprint._id, adminCaller());

        expect(sprint.deleteOne).toHaveBeenCalled();
    });

    it('returns 404 SPRINT_NOT_FOUND for unknown id', async () => {
        sprintFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.deleteSprint(new Types.ObjectId(), adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.SPRINT_NOT_FOUND,
        });
    });

    it('refuses with RESOURCE_HAS_DEPENDENTS when tasks reference this sprint (R3)', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        taskCountDocumentsMock.mockResolvedValueOnce(3);

        await expect(svc.deleteSprint(sprint._id, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_HAS_DEPENDENTS,
            details: { tasks: 3 },
        });
        // Sprint must NOT have been deleted.
        expect(sprint.deleteOne).not.toHaveBeenCalled();
    });

    it('T11 — an ARCHIVED sprint with lingering tasks IS deletable (escape hatch)', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, is_archived: true });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        // Even with tasks present, the archive flag bypasses the check —
        // the dependant-count query should NOT run.

        await svc.deleteSprint(sprint._id, adminCaller());

        expect(sprint.deleteOne).toHaveBeenCalled();
        // Pin the bypass: `Task.countDocuments` is never called when archived.
        expect(taskCountDocumentsMock).not.toHaveBeenCalled();
    });
});

// ─── archiveSprint / unarchiveSprint (T11) ───────────────────────────────

describe('archiveSprint / unarchiveSprint', () => {
    it('archiveSprint: flips is_archived true and audits', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, is_archived: false });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        const out = await svc.archiveSprint(sprint._id, adminCaller());

        expect(sprint.is_archived).toBe(true);
        expect(sprint.save).toHaveBeenCalled();
        expect(out.is_archived).toBe(true);
    });

    it('archiveSprint: idempotent — re-archiving is a no-op success without save()', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, is_archived: true });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        await svc.archiveSprint(sprint._id, adminCaller());

        expect(sprint.save).not.toHaveBeenCalled();
    });

    it('archiveSprint: non-manager is forbidden', async () => {
        await expect(svc.archiveSprint(new Types.ObjectId(), employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('unarchiveSprint: flips is_archived back to false', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, is_archived: true });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        await svc.unarchiveSprint(sprint._id, adminCaller());

        expect(sprint.is_archived).toBe(false);
        expect(sprint.save).toHaveBeenCalled();
    });

    it('unarchiveSprint: idempotent on a non-archived sprint', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, is_archived: false });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        await svc.unarchiveSprint(sprint._id, adminCaller());

        expect(sprint.save).not.toHaveBeenCalled();
    });
});

// ─── listSprints ─────────────────────────────────────────────────────────

describe('listSprints', () => {
    const stubChain = () =>
        sprintFindMock.mockReturnValueOnce({
            sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
        });

    it('filters by project_id (and optional status) and defaults is_archived=false', async () => {
        const proj = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        stubChain();
        sprintCountDocumentsMock.mockResolvedValueOnce(0);

        await svc.listSprints(proj._id, { page: 1, limit: 50, status: 'active' }, adminCaller());

        // F1 — `is_archived: false` is added implicitly so the default
        // list view shows only active sprints. Mirrors the project pattern.
        expect(sprintFindMock).toHaveBeenCalledWith({
            project_id: proj._id,
            status: 'active',
            is_archived: false,
        });
    });

    it('F1 — explicit is_archived=true returns ONLY archived sprints', async () => {
        const proj = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        stubChain();
        sprintCountDocumentsMock.mockResolvedValueOnce(0);

        await svc.listSprints(proj._id, { page: 1, limit: 50, is_archived: true }, adminCaller());

        expect(sprintFindMock).toHaveBeenCalledWith({
            project_id: proj._id,
            is_archived: true,
        });
    });

    it('F1 — explicit is_archived=false is the same as omitting it (default behaviour)', async () => {
        const proj = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        stubChain();
        sprintCountDocumentsMock.mockResolvedValueOnce(0);

        await svc.listSprints(proj._id, { page: 1, limit: 50, is_archived: false }, adminCaller());

        expect(sprintFindMock).toHaveBeenCalledWith({
            project_id: proj._id,
            is_archived: false,
        });
    });
});

// ─── startSprint (Phase 2 Backlog) ───────────────────────────────────────

/** Stub `Sprint.findOne(...).select().lean()` for the single-active check. */
const stubActiveLookup = (returns: { _id: Types.ObjectId } | null): void => {
    sprintFindOneMock.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(returns) }),
    });
};

describe('startSprint', () => {
    it('non-manager (employee) is forbidden', async () => {
        await expect(svc.startSprint(new Types.ObjectId(), employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('happy path: planned → active when no other sprint is active', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, status: 'planned' });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        stubActiveLookup(null);

        const out = await svc.startSprint(sprint._id, adminCaller());

        expect(sprint.status).toBe('active');
        expect(sprint.save).toHaveBeenCalled();
        expect(out).toMatchObject({ status: 'active' });
    });

    it('rejects with SPRINT_ALREADY_ACTIVE when another sprint in the project is active', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, status: 'planned' });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        stubActiveLookup({ _id: new Types.ObjectId() });

        await expect(svc.startSprint(sprint._id, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.SPRINT_ALREADY_ACTIVE,
        });
        expect(sprint.save).not.toHaveBeenCalled();
    });

    it('rejects a non-planned sprint with SPRINT_INVALID_TRANSITION', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, status: 'active' });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        await expect(svc.startSprint(sprint._id, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.SPRINT_INVALID_TRANSITION,
        });
        // The single-active lookup must not even run for a bad transition.
        expect(sprintFindOneMock).not.toHaveBeenCalled();
    });
});

// ─── completeSprint (Phase 2 Backlog) ────────────────────────────────────

/** Stub `Sprint.findById(...).select().lean()` for the target-sprint lookup. */
const stubTargetLookup = (returns: { project_id: Types.ObjectId; status: string } | null): void => {
    sprintFindByIdMock.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(returns) }),
    });
};

describe('completeSprint', () => {
    it('rejects a non-active sprint with SPRINT_INVALID_TRANSITION', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, status: 'planned' });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        await expect(
            svc.completeSprint(sprint._id, { move_unfinished_to: 'backlog' }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.SPRINT_INVALID_TRANSITION });
    });

    it('moves only unfinished tasks to the backlog and completes the sprint', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, status: 'active' });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        taskCountDocumentsMock.mockResolvedValueOnce(2); // two unfinished tasks

        const out = await svc.completeSprint(sprint._id, { move_unfinished_to: 'backlog' }, adminCaller());

        // Unfinished = status NOT in the terminal set (default: `done`).
        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            { sprint_id: sprint._id, status: { $nin: ['done'] } },
            { $set: { sprint_id: null } },
            expect.anything()
        );
        expect(sprint.status).toBe('completed');
        expect(sprint.save).toHaveBeenCalled();
        expect(out).toMatchObject({ moved_task_count: 2 });
        expect(out.sprint).toMatchObject({ status: 'completed' });
    });

    it('honours project custom terminal statuses when deciding what is unfinished', async () => {
        const proj = makeProject({
            custom_task_statuses: [
                { key: 'qa_passed', is_terminal: true },
                { key: 'blocked', is_terminal: false },
            ],
        });
        const sprint = makeSprint({ project_id: proj._id, status: 'active' });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        taskCountDocumentsMock.mockResolvedValueOnce(0);

        await svc.completeSprint(sprint._id, { move_unfinished_to: 'backlog' }, adminCaller());

        const filter = taskCountDocumentsMock.mock.calls[0][0] as { status: { $nin: string[] } };
        expect(new Set(filter.status.$nin)).toEqual(new Set(['done', 'qa_passed']));
        // No unfinished tasks → the bulk move is skipped entirely.
        expect(taskUpdateManyMock).not.toHaveBeenCalled();
    });

    it('moves unfinished tasks to a valid target planned sprint in the same project', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, status: 'active' });
        const targetId = new Types.ObjectId();
        sprintFindByIdMock.mockResolvedValueOnce(sprint); // loadSprintAndProject
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        stubTargetLookup({ project_id: proj._id, status: 'planned' }); // target lookup
        taskCountDocumentsMock.mockResolvedValueOnce(1);

        const out = await svc.completeSprint(sprint._id, { move_unfinished_to: targetId.toString() }, adminCaller());

        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            { sprint_id: sprint._id, status: { $nin: ['done'] } },
            { $set: { sprint_id: targetId } },
            expect.anything()
        );
        expect(out).toMatchObject({ moved_task_count: 1 });
    });

    it('rejects a target sprint from a different project with TASK_SPRINT_PROJECT_MISMATCH', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, status: 'active' });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        stubTargetLookup({ project_id: new Types.ObjectId(), status: 'planned' }); // different project

        await expect(
            svc.completeSprint(sprint._id, { move_unfinished_to: new Types.ObjectId().toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_SPRINT_PROJECT_MISMATCH });
        expect(taskUpdateManyMock).not.toHaveBeenCalled();
    });

    it('rejects a completed target sprint with TASK_SPRINT_PROJECT_MISMATCH', async () => {
        const proj = makeProject();
        const sprint = makeSprint({ project_id: proj._id, status: 'active' });
        sprintFindByIdMock.mockResolvedValueOnce(sprint);
        loadProjectForCallerMock.mockResolvedValueOnce(proj);
        stubTargetLookup({ project_id: proj._id, status: 'completed' }); // not planned/active

        await expect(
            svc.completeSprint(sprint._id, { move_unfinished_to: new Types.ObjectId().toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_SPRINT_PROJECT_MISMATCH });
    });
});

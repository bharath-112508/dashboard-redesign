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
    sprintCountDocumentsMock,
    loadProjectForCallerMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    sprintCreateMock: vi.fn(),
    sprintFindByIdMock: vi.fn(),
    sprintFindMock: vi.fn(),
    sprintCountDocumentsMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/sprint.model.js', () => ({
    Sprint: {
        create: sprintCreateMock,
        findById: sprintFindByIdMock,
        find: sprintFindMock,
        countDocuments: sprintCountDocumentsMock,
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { findById: vi.fn(), findOne: vi.fn(), find: vi.fn(), countDocuments: vi.fn(), create: vi.fn() },
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
            };
        },
        ...overrides,
    };
    sprint.save.mockImplementation(async () => sprint);
    return sprint;
};

beforeEach(() => {
    vi.resetAllMocks();
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
});

// ─── listSprints ─────────────────────────────────────────────────────────

describe('listSprints', () => {
    it('filters by project_id (and optional status) and paginates', async () => {
        const proj = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(proj);

        sprintFindMock.mockReturnValueOnce({
            sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
        });
        sprintCountDocumentsMock.mockResolvedValueOnce(0);

        await svc.listSprints(proj._id, { page: 1, limit: 50, status: 'active' }, adminCaller());

        expect(sprintFindMock).toHaveBeenCalledWith({ project_id: proj._id, status: 'active' });
    });
});

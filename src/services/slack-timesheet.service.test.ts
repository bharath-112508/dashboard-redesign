import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '../constants/permissions.js';
import { ROLES } from '../constants/roles.js';
import { SLACK_SELECT_OPTION_CAP } from '../constants/slack.js';

const { findMock, buildFilterMock, resolvePermissionsMock, taskFindMock, loadProjectForCallerMock } = vi.hoisted(
    () => ({
        findMock: vi.fn(),
        buildFilterMock: vi.fn(),
        resolvePermissionsMock: vi.fn(),
        taskFindMock: vi.fn(),
        loadProjectForCallerMock: vi.fn(),
    })
);

vi.mock('../models/task.model.js', () => ({
    Task: { find: taskFindMock },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { find: findMock },
}));

vi.mock('./project.service.js', () => ({
    buildProjectVisibilityFilter: buildFilterMock,
    loadProjectForCaller: loadProjectForCallerMock,
}));

vi.mock('./role.service.js', () => ({
    resolvePermissionsForUser: resolvePermissionsMock,
}));

const { loadLogTimeProjects, callerCanLogTime, loadLogTimeTickets } = await import('./slack-timesheet.service.js');

/** `Project.find()` returns a chainable query — mirror just the links used. */
const queryStub = (rows: unknown[]) => ({
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(rows),
});

const caller = { id: new Types.ObjectId(), role: ROLES.EMPLOYEE };

beforeEach(() => {
    vi.clearAllMocks();
    buildFilterMock.mockReturnValue({ member_ids: caller.id });
});

describe('loadLogTimeProjects', () => {
    it('returns id + label options for the caller visible projects', async () => {
        const id = new Types.ObjectId();
        const query = queryStub([{ _id: id, name: 'Nordmark Fleet Dashboard' }]);
        findMock.mockReturnValue(query);

        await expect(loadLogTimeProjects(caller)).resolves.toEqual([
            { id: id.toString(), label: 'Nordmark Fleet Dashboard' },
        ]);

        expect(query.sort).toHaveBeenCalledWith({ name: 1 });
        expect(query.limit).toHaveBeenCalledWith(SLACK_SELECT_OPTION_CAP);
    });

    it('scopes by the shared visibility filter rather than a local rule', async () => {
        // The whole point: an Employee must see exactly the projects every
        // other project read shows them. Re-deriving the rule here is the
        // drift this asserts against.
        const query = queryStub([]);
        findMock.mockReturnValue(query);

        await loadLogTimeProjects(caller);

        expect(buildFilterMock).toHaveBeenCalledWith(caller);
        expect(findMock).toHaveBeenCalledWith(expect.objectContaining({ member_ids: caller.id, is_archived: false }));
        expect(query.sort).toHaveBeenCalledWith({ name: 1 });
        expect(query.limit).toHaveBeenCalledWith(SLACK_SELECT_OPTION_CAP);
    });

    it('excludes archived projects', async () => {
        const query = queryStub([]);
        findMock.mockReturnValue(query);
        await loadLogTimeProjects(caller);
        expect(findMock.mock.calls[0]![0]).toMatchObject({ is_archived: false });
        expect(query.sort).toHaveBeenCalledWith({ name: 1 });
        expect(query.limit).toHaveBeenCalledWith(SLACK_SELECT_OPTION_CAP);
    });

    it('returns an empty list when the caller has no projects', async () => {
        const query = queryStub([]);
        findMock.mockReturnValue(query);
        await expect(loadLogTimeProjects(caller)).resolves.toEqual([]);
        expect(query.sort).toHaveBeenCalledWith({ name: 1 });
        expect(query.limit).toHaveBeenCalledWith(SLACK_SELECT_OPTION_CAP);
    });
});

/**
 * Pins `callerCanLogTime`'s contract — it must ask the SAME question
 * `slack-home.service.ts` asks to decide whether to render the Log Time
 * button (`callerCan(perms, PERMISSIONS.TIMESHEET_WRITE)`), not a role
 * check. A role check fails open for a caller assigned only a restricted
 * custom role (see this function's doc comment in `slack-timesheet.service.ts`).
 */
describe('callerCanLogTime', () => {
    it('allows a caller whose resolved permissions include timesheet.write', async () => {
        resolvePermissionsMock.mockResolvedValue({ permissions: [PERMISSIONS.TIMESHEET_WRITE] });
        await expect(callerCanLogTime(caller.id)).resolves.toBe(true);
    });

    it('allows a caller via the system.admin wildcard', async () => {
        resolvePermissionsMock.mockResolvedValue({ permissions: [PERMISSIONS.SYSTEM_ADMIN] });
        await expect(callerCanLogTime(caller.id)).resolves.toBe(true);
    });

    it('refuses a caller without timesheet.write, regardless of their legacy role', async () => {
        // The headline round-3 case: a caller assigned ONLY a restricted
        // custom role that excludes timesheet.write — their legacy `role`
        // field is irrelevant here because this function never reads it.
        resolvePermissionsMock.mockResolvedValue({ permissions: [PERMISSIONS.PROJECT_READ] });
        await expect(callerCanLogTime(caller.id)).resolves.toBe(false);
    });

    it('refuses a caller with no resolved permissions at all', async () => {
        resolvePermissionsMock.mockResolvedValue({ permissions: [] });
        await expect(callerCanLogTime(caller.id)).resolves.toBe(false);
    });
});

// ─── loadLogTimeTickets ───────────────────────────────────────────────────
//
// Feeds the Ticket select. Scope is "MY open tickets in THIS project": the
// list has to stay short enough to scan in a dropdown, and Slack caps a
// static_select at 100 options regardless.

describe('loadLogTimeTickets', () => {
    const projectId = new Types.ObjectId();

    beforeEach(() => {
        loadProjectForCallerMock.mockResolvedValue({ _id: projectId, code: 'VLJ' });
    });

    it("asks for the caller's own non-done tasks in that project", async () => {
        taskFindMock.mockReturnValue(queryStub([]));
        await loadLogTimeTickets(projectId.toString(), caller);

        const filter = taskFindMock.mock.calls[0]![0] as Record<string, unknown>;
        expect(filter.project_id).toStrictEqual(projectId);
        // assignee_ids, not primary_assignee_id — a task assigned to several
        // people belongs to all of them equally (see task.model.ts).
        expect(filter.assignee_ids).toStrictEqual(caller.id);
        expect(filter.status).toEqual({ $ne: 'done' });
    });

    it('labels options as {project code}-{task number} {title}', async () => {
        taskFindMock.mockReturnValue(
            queryStub([{ _id: new Types.ObjectId('6a9ff1a60f7ba40f3388d705'), task_number: 142, title: 'Fix login' }])
        );
        const out = await loadLogTimeTickets(projectId.toString(), caller);
        expect(out).toEqual([{ id: '6a9ff1a60f7ba40f3388d705', label: 'VLJ-142 Fix login' }]);
    });

    it('caps at the Slack option ceiling', async () => {
        taskFindMock.mockReturnValue(queryStub([]));
        await loadLogTimeTickets(projectId.toString(), caller);
        expect(queryStub([]).limit).toBeDefined();
        const q = taskFindMock.mock.results[0]!.value as { limit: ReturnType<typeof vi.fn> };
        expect(q.limit).toHaveBeenCalledWith(SLACK_SELECT_OPTION_CAP);
    });

    it('returns nothing for a project the caller cannot see, instead of throwing', async () => {
        // This feeds a dropdown, so it must degrade rather than break the
        // modal. It is NOT the authorization boundary: `createEntry` calls
        // loadTaskForCaller/loadProjectForCaller on the write itself, so a
        // forged submission naming a hidden project is still refused there.
        loadProjectForCallerMock.mockRejectedValue(new Error('forbidden'));
        await expect(loadLogTimeTickets(projectId.toString(), caller)).resolves.toEqual([]);
        expect(taskFindMock).not.toHaveBeenCalled();
    });

    it('returns nothing for a malformed project id', async () => {
        await expect(loadLogTimeTickets('not-an-id', caller)).resolves.toEqual([]);
        expect(taskFindMock).not.toHaveBeenCalled();
    });
});

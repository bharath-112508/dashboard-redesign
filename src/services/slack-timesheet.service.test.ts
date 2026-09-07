import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '../constants/permissions.js';
import { ROLES } from '../constants/roles.js';
import { SLACK_SELECT_OPTION_CAP } from '../constants/slack.js';

const { findMock, buildFilterMock, resolvePermissionsMock } = vi.hoisted(() => ({
    findMock: vi.fn(),
    buildFilterMock: vi.fn(),
    resolvePermissionsMock: vi.fn(),
}));

vi.mock('../models/project.model.js', () => ({
    Project: { find: findMock },
}));

vi.mock('./project.service.js', () => ({
    buildProjectVisibilityFilter: buildFilterMock,
}));

vi.mock('./role.service.js', () => ({
    resolvePermissionsForUser: resolvePermissionsMock,
}));

const { loadLogTimeProjects, callerCanLogTime } = await import('./slack-timesheet.service.js');

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

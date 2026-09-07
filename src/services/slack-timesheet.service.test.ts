import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROLES } from '../constants/roles.js';

const { findMock, buildFilterMock } = vi.hoisted(() => ({
    findMock: vi.fn(),
    buildFilterMock: vi.fn(),
}));

vi.mock('../models/project.model.js', () => ({
    Project: { find: findMock },
}));

vi.mock('./project.service.js', () => ({
    buildProjectVisibilityFilter: buildFilterMock,
}));

const { loadLogTimeProjects } = await import('./slack-timesheet.service.js');

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
        findMock.mockReturnValue(queryStub([{ _id: id, name: 'Nordmark Fleet Dashboard' }]));

        await expect(loadLogTimeProjects(caller)).resolves.toEqual([
            { id: id.toString(), label: 'Nordmark Fleet Dashboard' },
        ]);
    });

    it('scopes by the shared visibility filter rather than a local rule', async () => {
        // The whole point: an Employee must see exactly the projects every
        // other project read shows them. Re-deriving the rule here is the
        // drift this asserts against.
        findMock.mockReturnValue(queryStub([]));

        await loadLogTimeProjects(caller);

        expect(buildFilterMock).toHaveBeenCalledWith(caller);
        expect(findMock).toHaveBeenCalledWith(expect.objectContaining({ member_ids: caller.id, is_archived: false }));
    });

    it('excludes archived projects', async () => {
        findMock.mockReturnValue(queryStub([]));
        await loadLogTimeProjects(caller);
        expect(findMock.mock.calls[0]![0]).toMatchObject({ is_archived: false });
    });

    it('returns an empty list when the caller has no projects', async () => {
        findMock.mockReturnValue(queryStub([]));
        await expect(loadLogTimeProjects(caller)).resolves.toEqual([]);
    });
});

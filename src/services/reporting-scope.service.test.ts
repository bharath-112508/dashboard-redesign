import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';

const { userFindMock, userFindByIdMock, projectFindMock } = vi.hoisted(() => ({
    userFindMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    projectFindMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock, findById: userFindByIdMock },
}));
vi.mock('../models/project.model.js', () => ({ Project: { find: projectFindMock } }));

import * as scope from './reporting-scope.service.js';

/** The `$or` query that resolves reports ∪ peers down to active internal users. */
const stubTeam = (ids: Types.ObjectId[]) => userFindMock.mockReturnValue({ distinct: () => Promise.resolve(ids) });
const stubReports = stubTeam;
const stubProjects = (rosters: Types.ObjectId[][]) =>
    projectFindMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve(rosters.map((member_ids) => ({ member_ids }))) }),
    });
const stubManager = (managerId: Types.ObjectId | null) =>
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ internal_profile: { reporting_manager_id: managerId } }) }),
    });

describe('reporting-scope', () => {
    beforeEach(() => {
        userFindMock.mockReset();
        userFindByIdMock.mockReset();
        projectFindMock.mockReset();
        stubProjects([]);
    });

    it('directReportIdsOf queries active reports of the manager', async () => {
        const mgr = new Types.ObjectId();
        const reports = [new Types.ObjectId(), new Types.ObjectId()];
        stubReports(reports);
        await expect(scope.directReportIdsOf(mgr)).resolves.toEqual(reports);
        expect(userFindMock.mock.calls[0][0]['internal_profile.reporting_manager_id']).toEqual(mgr);
    });

    it('isDirectReportOf is true only when the manager matches', async () => {
        const mgr = new Types.ObjectId();
        const user = new Types.ObjectId();
        stubManager(mgr);
        await expect(scope.isDirectReportOf(user, mgr)).resolves.toBe(true);
        stubManager(new Types.ObjectId());
        await expect(scope.isDirectReportOf(user, mgr)).resolves.toBe(false);
        stubManager(null);
        await expect(scope.isDirectReportOf(user, mgr)).resolves.toBe(false);
    });

    it('visibleUserIdsForReviewer: admin → null (no restriction)', async () => {
        await expect(
            scope.visibleUserIdsForReviewer({ id: new Types.ObjectId(), role: ROLES.ADMIN })
        ).resolves.toBeNull();
        expect(userFindMock).not.toHaveBeenCalled();
    });

    it('visibleUserIdsForReviewer: manager → their team', async () => {
        const team = [new Types.ObjectId()];
        stubTeam(team);
        await expect(
            scope.visibleUserIdsForReviewer({ id: new Types.ObjectId(), role: ROLES.MANAGER })
        ).resolves.toEqual(team);
    });

    // The whole point of the union: a Team Lead whose reporting chain nobody
    // filled in still sees the people on their projects, which is what their
    // own dashboard has always counted.
    it('teamScopeIdsOf asks for reports OR project peers, among active internal users', async () => {
        const lead = new Types.ObjectId();
        const peer = new Types.ObjectId();
        stubProjects([[lead, peer]]);
        stubTeam([lead, peer]);

        await expect(scope.teamScopeIdsOf(lead)).resolves.toEqual([lead, peer]);

        expect(projectFindMock).toHaveBeenCalledWith({ member_ids: lead });
        const filter = userFindMock.mock.calls[0]![0] as {
            status: string;
            role: { $nin: string[] };
            $or: Record<string, unknown>[];
        };
        expect(filter.$or).toEqual([{ 'internal_profile.reporting_manager_id': lead }, { _id: { $in: [lead, peer] } }]);
        // Deactivated members and client-side people on a roster must not leak.
        expect(filter.status).toBe('active');
        expect(filter.role.$nin).toContain(ROLES.CLIENT);
        expect(filter.role.$nin).toContain(ROLES.REPRESENTATIVE);
    });

    it('teamScopeIdsOf dedupes someone who is both a report and a project peer', async () => {
        const lead = new Types.ObjectId();
        const shared = new Types.ObjectId();
        stubProjects([[lead, shared], [shared]]);
        stubTeam([lead, shared]);

        await scope.teamScopeIdsOf(lead);

        const filter = userFindMock.mock.calls[0]![0] as { $or: { _id?: { $in: Types.ObjectId[] } }[] };
        expect(filter.$or[1]!._id!.$in).toHaveLength(2);
    });

    describe('scopedUserIdFilter', () => {
        it('admin, no user_id → undefined (leave base filter untouched)', async () => {
            await expect(
                scope.scopedUserIdFilter({ id: new Types.ObjectId(), role: ROLES.ADMIN })
            ).resolves.toBeUndefined();
        });

        it('admin, user_id → that id', async () => {
            const uid = new Types.ObjectId();
            await expect(
                scope.scopedUserIdFilter({ id: new Types.ObjectId(), role: ROLES.ADMIN }, uid.toString())
            ).resolves.toEqual(uid);
        });

        it('manager, no user_id → $in team', async () => {
            const reports = [new Types.ObjectId(), new Types.ObjectId()];
            stubReports(reports);
            await expect(
                scope.scopedUserIdFilter({ id: new Types.ObjectId(), role: ROLES.TEAM_LEAD })
            ).resolves.toEqual({ $in: reports });
        });

        it('manager drilling into someone in their team → that id; outside it → empty', async () => {
            const report = new Types.ObjectId();
            const other = new Types.ObjectId();
            stubReports([report]);
            await expect(
                scope.scopedUserIdFilter({ id: new Types.ObjectId(), role: ROLES.MANAGER }, report.toString())
            ).resolves.toEqual(report);
            stubReports([report]);
            await expect(
                scope.scopedUserIdFilter({ id: new Types.ObjectId(), role: ROLES.MANAGER }, other.toString())
            ).resolves.toEqual({ $in: [] });
        });
    });
});

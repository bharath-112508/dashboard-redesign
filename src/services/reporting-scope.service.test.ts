import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';

const { userFindMock, userFindByIdMock } = vi.hoisted(() => ({
    userFindMock: vi.fn(),
    userFindByIdMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock, findById: userFindByIdMock },
}));

import * as scope from './reporting-scope.service.js';

const stubReports = (ids: Types.ObjectId[]) => userFindMock.mockReturnValue({ distinct: () => Promise.resolve(ids) });
const stubManager = (managerId: Types.ObjectId | null) =>
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ internal_profile: { reporting_manager_id: managerId } }) }),
    });

describe('reporting-scope', () => {
    beforeEach(() => {
        userFindMock.mockReset();
        userFindByIdMock.mockReset();
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

    it('visibleUserIdsForReviewer: manager → their direct reports', async () => {
        const reports = [new Types.ObjectId()];
        stubReports(reports);
        await expect(
            scope.visibleUserIdsForReviewer({ id: new Types.ObjectId(), role: ROLES.MANAGER })
        ).resolves.toEqual(reports);
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

        it('manager, no user_id → $in reports', async () => {
            const reports = [new Types.ObjectId(), new Types.ObjectId()];
            stubReports(reports);
            await expect(
                scope.scopedUserIdFilter({ id: new Types.ObjectId(), role: ROLES.TEAM_LEAD })
            ).resolves.toEqual({ $in: reports });
        });

        it('manager drilling into a report → that id; into a non-report → empty', async () => {
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

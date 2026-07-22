import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { PROJECT_STATUSES } from '../constants/project.js';

/**
 * Unit tests for the range-aware dashboard overview aggregation helpers
 * (Task 2, docs/superpowers/plans dashboard rework).
 *
 * These are pure, reusable building blocks — later per-role dashboard
 * builders compose them. Kept fully decoupled from `dashboard.service.ts`
 * (which owns the existing Phase-1 single-day payloads) so this file can
 * mock exactly the models it needs.
 */

// ─── Hoisted mocks ──────────────────────────────────────────────────────

const {
    userAggregateMock,
    userCountMock,
    attendanceAggregateMock,
    attendanceDistinctMock,
    correctionCountMock,
    projectAggregateMock,
    loggerWarnMock,
} = vi.hoisted(() => ({
    userAggregateMock: vi.fn(),
    userCountMock: vi.fn(),
    attendanceAggregateMock: vi.fn(),
    attendanceDistinctMock: vi.fn(),
    correctionCountMock: vi.fn(),
    projectAggregateMock: vi.fn(),
    loggerWarnMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        aggregate: userAggregateMock,
        countDocuments: userCountMock,
    },
}));

vi.mock('../models/attendance-record.model.js', () => ({
    AttendanceRecord: {
        aggregate: attendanceAggregateMock,
        distinct: attendanceDistinctMock,
    },
}));

vi.mock('../models/attendance-correction-request.model.js', () => ({
    AttendanceCorrectionRequest: {
        countDocuments: correctionCountMock,
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: {
        aggregate: projectAggregateMock,
    },
}));

vi.mock('../utils/logger.js', () => ({
    default: { warn: loggerWarnMock, info: vi.fn() },
}));

const overview = await import('./dashboard-overview.service.js');

beforeEach(() => {
    userAggregateMock.mockReset();
    userCountMock.mockReset();
    attendanceAggregateMock.mockReset();
    attendanceDistinctMock.mockReset();
    correctionCountMock.mockReset();
    projectAggregateMock.mockReset();
    loggerWarnMock.mockReset();
});

// ─── headcountAsOf ─────────────────────────────────────────────────────

describe('headcountAsOf', () => {
    it('counts users created on/before the date, active or deactivated after it', async () => {
        userCountMock.mockResolvedValueOnce(7);

        const out = await overview.headcountAsOf('2026-07-22', [ROLES.EMPLOYEE, ROLES.TEAM_LEAD]);

        expect(out).toBe(7);
        const filter = userCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.role).toEqual({ $in: [ROLES.EMPLOYEE, ROLES.TEAM_LEAD] });
        expect(filter.created_at).toHaveProperty('$lte');
        expect(filter.$or).toEqual([
            { deactivated_at: null },
            { deactivated_at: { $gt: (filter.created_at as { $lte: Date }).$lte } },
        ]);
    });

    it('falls back to 0 and logs when the count throws', async () => {
        userCountMock.mockRejectedValueOnce(new Error('boom'));

        const out = await overview.headcountAsOf('2026-07-22', [ROLES.EMPLOYEE]);

        expect(out).toBe(0);
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'overview.headcount_as_of' }),
            'Dashboard card aggregation failed'
        );
    });
});

// ─── projectStatusFor ───────────────────────────────────────────────────

describe('projectStatusFor', () => {
    it('groups by status into active/completed/on_hold + total, excluding archived', async () => {
        projectAggregateMock.mockResolvedValueOnce([
            { _id: PROJECT_STATUSES.ACTIVE, count: 5 },
            { _id: PROJECT_STATUSES.COMPLETED, count: 3 },
            { _id: PROJECT_STATUSES.ON_HOLD, count: 1 },
        ]);

        const out = await overview.projectStatusFor({ company_id: new Types.ObjectId() });

        expect(out).toEqual({ active: 5, completed: 3, on_hold: 1, total: 9 });
        const pipeline = projectAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const matchStage = pipeline[0].$match as Record<string, unknown>;
        expect(matchStage.is_archived).toEqual({ $ne: true });
    });

    it('falls back to all-zero shape when the aggregation throws', async () => {
        projectAggregateMock.mockRejectedValueOnce(new Error('boom'));

        const out = await overview.projectStatusFor({});

        expect(out).toEqual({ active: 0, completed: 0, on_hold: 0, total: 0 });
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'overview.project_status' }),
            'Dashboard card aggregation failed'
        );
    });
});

// ─── attendanceOverviewFor ────────────────────────────────────────────────

describe('attendanceOverviewFor', () => {
    it('single day: present = that day count, is_single_day true', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: 'present', count: 9 },
            { _id: 'on_leave', count: 2 },
        ]);
        correctionCountMock.mockResolvedValueOnce(1);
        userCountMock.mockResolvedValueOnce(20);

        const out = await overview.attendanceOverviewFor('2026-07-22', '2026-07-22', null);

        expect(out).toMatchObject({
            present: 9,
            on_leave: 2,
            correction_requests: 1,
            incomplete: 0,
            is_single_day: true,
        });
        expect(out.total_internal_active).toBe(20);
        // Single-day path must not query distinct working days.
        expect(attendanceDistinctMock).not.toHaveBeenCalled();
    });

    it('single day: incomplete comes from the status group', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: 'present', count: 9 },
            { _id: 'incomplete', count: 3 },
        ]);
        correctionCountMock.mockResolvedValueOnce(3);
        userCountMock.mockResolvedValueOnce(20);

        const out = await overview.attendanceOverviewFor('2026-07-22', '2026-07-22', null);

        expect(out.incomplete).toBe(3);
        expect(out.correction_requests).toBe(3);
    });

    it('range: present = round(total present-records / distinct working days), on_leave = total leave-days', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: 'present', count: 27 },
            { _id: 'on_leave', count: 4 },
            { _id: 'incomplete', count: 2 },
        ]);
        // 4 distinct working days in the window.
        attendanceDistinctMock.mockResolvedValueOnce(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23']);
        correctionCountMock.mockResolvedValueOnce(5);
        userCountMock.mockResolvedValueOnce(15);

        const out = await overview.attendanceOverviewFor('2026-07-20', '2026-07-24', null);

        expect(out.is_single_day).toBe(false);
        expect(out.present).toBe(7); // round(27/4) = 6.75 → 7
        expect(out.on_leave).toBe(4);
        expect(out.incomplete).toBe(2);
        expect(out.correction_requests).toBe(5);
        expect(out.total_internal_active).toBe(15);
    });

    it('range: zero working days degrades present to 0 instead of dividing by zero', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([]);
        attendanceDistinctMock.mockResolvedValueOnce([]);
        correctionCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(0);

        const out = await overview.attendanceOverviewFor('2026-07-20', '2026-07-24', null);

        expect(out.present).toBe(0);
    });

    it('scopes user_id filter on every query when userIds is provided', async () => {
        const u1 = new Types.ObjectId();
        const u2 = new Types.ObjectId();
        attendanceAggregateMock.mockResolvedValueOnce([{ _id: 'present', count: 2 }]);
        correctionCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(2);

        await overview.attendanceOverviewFor('2026-07-22', '2026-07-22', [u1, u2]);

        const pipeline = attendanceAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const matchStage = pipeline[0].$match as Record<string, unknown>;
        expect(matchStage.user_id).toEqual({ $in: [u1, u2] });

        const correctionFilter = correctionCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(correctionFilter.user_id).toEqual({ $in: [u1, u2] });

        const userFilter = userCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(userFilter._id).toEqual({ $in: [u1, u2] });
    });

    it('does not filter by user_id when userIds is null (org-wide scope)', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([{ _id: 'present', count: 2 }]);
        correctionCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(2);

        await overview.attendanceOverviewFor('2026-07-22', '2026-07-22', null);

        const pipeline = attendanceAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const matchStage = pipeline[0].$match as Record<string, unknown>;
        expect(matchStage.user_id).toBeUndefined();

        const correctionFilter = correctionCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(correctionFilter.user_id).toBeUndefined();
    });

    it('falls back to a zero shape (preserving is_single_day) when the status aggregate throws', async () => {
        attendanceAggregateMock.mockRejectedValueOnce(new Error('boom'));

        const out = await overview.attendanceOverviewFor('2026-07-20', '2026-07-24', null);

        expect(out).toEqual({
            present: 0,
            on_leave: 0,
            correction_requests: 0,
            incomplete: 0,
            total_internal_active: 0,
            is_single_day: false,
        });
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'overview.attendance' }),
            'Dashboard card aggregation failed'
        );
    });
});

// ─── representativesStatusFor ───────────────────────────────────────────

describe('representativesStatusFor', () => {
    it('groups representatives of a company by active/deactivated', async () => {
        const companyId = new Types.ObjectId();
        userAggregateMock.mockResolvedValueOnce([
            { _id: USER_STATUSES.ACTIVE, count: 4 },
            { _id: USER_STATUSES.DEACTIVATED, count: 1 },
        ]);

        const out = await overview.representativesStatusFor(companyId);

        expect(out).toEqual({ active: 4, inactive: 1, total: 5 });
        const pipeline = userAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const matchStage = pipeline[0].$match as Record<string, unknown>;
        expect(matchStage.role).toBe(ROLES.REPRESENTATIVE);
        expect(matchStage['client_profile.company_id']).toEqual(companyId);
    });

    it('falls back to all-zero shape when the aggregation throws', async () => {
        userAggregateMock.mockRejectedValueOnce(new Error('boom'));

        const out = await overview.representativesStatusFor(new Types.ObjectId());

        expect(out).toEqual({ active: 0, inactive: 0, total: 0 });
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'overview.representatives_status' }),
            'Dashboard card aggregation failed'
        );
    });
});

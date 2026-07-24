import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `margin.service` (Billing Phase 2 — Cost Rates & Margin,
 * Task 4). This is the core PSA-equation computation:
 *
 *   revenue_native = (billable_minutes / 60) × bill_rate  (project currency)
 *   cost_native    = (billable_minutes / 60) × cost_rate  (cost rate currency)
 *   revenue, cost  → converted to the reporting currency via FX
 *   margin         = revenue − cost
 *
 * All DB-touching dependencies are mocked; `toReportingCurrency` /
 * `AppError` / `ERROR_CODES` are the REAL implementations (pure, no DB) so
 * the FX-missing → warning path is exercised faithfully.
 */

// ─── Hoisted mocks ───────────────────────────────────────────────────────

const {
    projectFindMock,
    engagementFindMock,
    userFindMock,
    sumBillableByUserMock,
    resolveUserRatesMock,
    resolveCostRateForUserMock,
    getOrInitSettingsMock,
} = vi.hoisted(() => ({
    projectFindMock: vi.fn(),
    engagementFindMock: vi.fn(),
    userFindMock: vi.fn(),
    sumBillableByUserMock: vi.fn(),
    resolveUserRatesMock: vi.fn(),
    resolveCostRateForUserMock: vi.fn(),
    getOrInitSettingsMock: vi.fn(),
}));

vi.mock('../models/project.model.js', () => ({
    Project: {
        find: (filter: unknown) => ({
            select: () => ({
                lean: () => Promise.resolve(projectFindMock(filter) ?? []),
            }),
        }),
    },
}));

vi.mock('../models/engagement.model.js', () => ({
    Engagement: {
        find: (filter: unknown) => ({
            select: () => ({
                sort: () => ({
                    lean: () => Promise.resolve(engagementFindMock(filter) ?? []),
                }),
            }),
        }),
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        find: (filter: unknown) => ({
            select: () => ({
                lean: () => Promise.resolve(userFindMock(filter) ?? []),
            }),
        }),
    },
}));

vi.mock('./invoice.service.js', () => ({
    sumBillableByUser: (...args: unknown[]) => sumBillableByUserMock(...args),
    resolveUserRates: (...args: unknown[]) => resolveUserRatesMock(...args),
}));

vi.mock('./cost-rate.service.js', () => ({
    resolveCostRateForUser: (...args: unknown[]) => resolveCostRateForUserMock(...args),
}));

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: () => getOrInitSettingsMock(),
}));

import { buildMarginReport } from './margin.service.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

const companyId = new Types.ObjectId();
const projectId = new Types.ObjectId();
const projectId2 = new Types.ObjectId();
const userId = new Types.ObjectId();
const userId2 = new Types.ObjectId();

const settingsWith = (fx_rates: { currency: string; rate_to_base: number }[], reporting_currency = 'INR') => ({
    billing: { reporting_currency, fx_rates },
});

beforeEach(() => {
    vi.clearAllMocks();
});

describe('buildMarginReport', () => {
    it('computes revenue/cost/margin/margin_pct for one project, one user (the worked example)', async () => {
        projectFindMock.mockReturnValue([{ _id: projectId, name: 'Nordic App', company_id: companyId }]);
        engagementFindMock.mockReturnValue([
            { company_id: companyId, project_ids: [], currency: 'EUR', start_date: '2026-01-01' },
        ]);
        sumBillableByUserMock.mockResolvedValue([{ user_id: userId, billable_minutes: 600 }]); // 10h
        resolveUserRatesMock.mockResolvedValue(new Map([[userId.toString(), 100]])); // €100/hr
        resolveCostRateForUserMock.mockResolvedValue({ cost_per_hour: 4000, currency: 'INR' }); // ₹4000/hr
        userFindMock.mockReturnValue([{ _id: userId, full_name: 'Asha Rao' }]);
        getOrInitSettingsMock.mockResolvedValue(settingsWith([{ currency: 'EUR', rate_to_base: 90 }]));

        const result = await buildMarginReport({ from_date: '2026-07-01', to_date: '2026-07-31' });

        expect(result.reporting_currency).toBe('INR');
        expect(result.rows).toHaveLength(1);

        const project = result.rows[0];
        expect(project.project).toEqual({ id: projectId.toString(), name: 'Nordic App' });
        expect(project.revenue).toBe(90000); // 10 * 100 * 90
        expect(project.cost).toBe(40000); // 10 * 4000
        expect(project.margin).toBe(50000);
        expect(project.margin_pct).toBeCloseTo(0.5556, 4);

        expect(project.users).toHaveLength(1);
        const userRow = project.users[0];
        expect(userRow.user).toEqual({ id: userId.toString(), full_name: 'Asha Rao' });
        expect(userRow.billable_minutes).toBe(600);
        expect(userRow.revenue).toBe(90000);
        expect(userRow.cost).toBe(40000);
        expect(userRow.margin).toBe(50000);

        expect(result.totals).toEqual({ revenue: 90000, cost: 40000, margin: 50000, margin_pct: 0.5556 });
        expect(result.warnings).toEqual([]);
    });

    it('zeroes cost and warns when a user has no cost rate', async () => {
        projectFindMock.mockReturnValue([{ _id: projectId, name: 'Nordic App', company_id: companyId }]);
        engagementFindMock.mockReturnValue([
            { company_id: companyId, project_ids: [], currency: 'INR', start_date: '2026-01-01' },
        ]);
        sumBillableByUserMock.mockResolvedValue([{ user_id: userId, billable_minutes: 600 }]);
        resolveUserRatesMock.mockResolvedValue(new Map([[userId.toString(), 1000]]));
        resolveCostRateForUserMock.mockResolvedValue(null); // no cost rate on file
        userFindMock.mockReturnValue([{ _id: userId, full_name: 'Sneha Patil' }]);
        getOrInitSettingsMock.mockResolvedValue(settingsWith([]));

        const result = await buildMarginReport({ from_date: '2026-07-01', to_date: '2026-07-31' });

        const userRow = result.rows[0].users[0];
        expect(userRow.cost).toBe(0);
        expect(userRow.revenue).toBe(10000); // 10h * 1000
        expect(userRow.margin).toBe(10000);
        expect(result.warnings).toContain('No cost rate for Sneha Patil');
    });

    it('zeroes revenue and warns once when the project currency has no configured FX rate', async () => {
        projectFindMock.mockReturnValue([{ _id: projectId, name: 'Fjord Portal', company_id: companyId }]);
        engagementFindMock.mockReturnValue([
            { company_id: companyId, project_ids: [], currency: 'NOK', start_date: '2026-01-01' },
        ]);
        sumBillableByUserMock.mockResolvedValue([
            { user_id: userId, billable_minutes: 600 },
            { user_id: userId2, billable_minutes: 300 },
        ]);
        resolveUserRatesMock.mockResolvedValue(
            new Map([
                [userId.toString(), 100],
                [userId2.toString(), 100],
            ])
        );
        resolveCostRateForUserMock.mockResolvedValue({ cost_per_hour: 2000, currency: 'INR' });
        userFindMock.mockReturnValue([
            { _id: userId, full_name: 'A' },
            { _id: userId2, full_name: 'B' },
        ]);
        getOrInitSettingsMock.mockResolvedValue(settingsWith([])); // no NOK rate configured

        const result = await buildMarginReport({ from_date: '2026-07-01', to_date: '2026-07-31' });

        expect(() => result).not.toThrow();
        const project = result.rows[0];
        expect(project.users[0].revenue).toBe(0);
        expect(project.users[1].revenue).toBe(0);
        expect(project.revenue).toBe(0);
        // cost still converts fine (INR === reporting currency)
        expect(project.users[0].cost).toBe(20000);
        // de-duplicated — one warning even though two users hit the same missing rate
        expect(result.warnings.filter((w) => w === 'No FX rate for NOK')).toHaveLength(1);
    });

    it('sums totals across multiple projects and keeps per-user breakdowns', async () => {
        projectFindMock.mockReturnValue([
            { _id: projectId, name: 'Project One', company_id: companyId },
            { _id: projectId2, name: 'Project Two', company_id: companyId },
        ]);
        engagementFindMock.mockReturnValue([
            { company_id: companyId, project_ids: [], currency: 'INR', start_date: '2026-01-01' },
        ]);

        sumBillableByUserMock.mockImplementation(async ({ projectIds }: { projectIds: Types.ObjectId[] }) => {
            if (projectIds[0].equals(projectId)) return [{ user_id: userId, billable_minutes: 600 }];
            return [{ user_id: userId2, billable_minutes: 120 }];
        });
        resolveUserRatesMock.mockImplementation(async ({ projectIds }: { projectIds: Types.ObjectId[] }) => {
            if (projectIds[0].equals(projectId)) return new Map([[userId.toString(), 500]]);
            return new Map([[userId2.toString(), 500]]);
        });
        resolveCostRateForUserMock.mockResolvedValue({ cost_per_hour: 1000, currency: 'INR' });
        userFindMock.mockReturnValue([
            { _id: userId, full_name: 'Asha Rao' },
            { _id: userId2, full_name: 'Ravi Kumar' },
        ]);
        getOrInitSettingsMock.mockResolvedValue(settingsWith([]));

        const result = await buildMarginReport({ from_date: '2026-07-01', to_date: '2026-07-31' });

        expect(result.rows).toHaveLength(2);
        // Project One: 10h*500=5000 rev, 10h*1000=10000 cost, margin -5000
        expect(result.rows[0].revenue).toBe(5000);
        expect(result.rows[0].cost).toBe(10000);
        // Project Two: 2h*500=1000 rev, 2h*1000=2000 cost
        expect(result.rows[1].revenue).toBe(1000);
        expect(result.rows[1].cost).toBe(2000);

        expect(result.totals.revenue).toBe(6000);
        expect(result.totals.cost).toBe(12000);
        expect(result.totals.margin).toBe(-6000);

        expect(result.rows[0].users).toHaveLength(1);
        expect(result.rows[1].users).toHaveLength(1);
    });

    it('reports margin_pct as null when project/total revenue is 0', async () => {
        projectFindMock.mockReturnValue([{ _id: projectId, name: 'No Rate Project', company_id: companyId }]);
        engagementFindMock.mockReturnValue([
            { company_id: companyId, project_ids: [], currency: 'INR', start_date: '2026-01-01' },
        ]);
        sumBillableByUserMock.mockResolvedValue([{ user_id: userId, billable_minutes: 600 }]);
        resolveUserRatesMock.mockResolvedValue(new Map()); // no bill rate at all → revenue 0
        resolveCostRateForUserMock.mockResolvedValue({ cost_per_hour: 500, currency: 'INR' });
        userFindMock.mockReturnValue([{ _id: userId, full_name: 'Kavya Nair' }]);
        getOrInitSettingsMock.mockResolvedValue(settingsWith([]));

        const result = await buildMarginReport({ from_date: '2026-07-01', to_date: '2026-07-31' });

        expect(result.rows[0].revenue).toBe(0);
        expect(result.rows[0].margin_pct).toBeNull();
        expect(result.totals.margin_pct).toBeNull();
        expect(result.warnings).toContain('No bill rate for Kavya Nair');
    });

    it('prefers an explicit project-listed engagement over a company-wide one', async () => {
        projectFindMock.mockReturnValue([{ _id: projectId, name: 'Explicit Wins', company_id: companyId }]);
        engagementFindMock.mockReturnValue([
            // Explicit, started later — should win.
            { company_id: companyId, project_ids: [projectId], currency: 'USD', start_date: '2026-02-01' },
            // Company-wide, started earlier.
            { company_id: companyId, project_ids: [], currency: 'EUR', start_date: '2026-01-01' },
        ]);
        sumBillableByUserMock.mockResolvedValue([{ user_id: userId, billable_minutes: 60 }]); // 1h
        resolveUserRatesMock.mockResolvedValue(new Map([[userId.toString(), 100]]));
        resolveCostRateForUserMock.mockResolvedValue({ cost_per_hour: 100, currency: 'INR' });
        userFindMock.mockReturnValue([{ _id: userId, full_name: 'X' }]);
        getOrInitSettingsMock.mockResolvedValue(
            settingsWith([
                { currency: 'USD', rate_to_base: 83 },
                { currency: 'EUR', rate_to_base: 90 },
            ])
        );

        const result = await buildMarginReport({ from_date: '2026-07-01', to_date: '2026-07-31' });

        // 1h * 100 * 83 (USD rate) = 8300, not 9000 (EUR rate) — proves explicit-project wins.
        expect(result.rows[0].revenue).toBe(8300);
    });
});

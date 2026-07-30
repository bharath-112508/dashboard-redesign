import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `engagement.service` (Phase 1 — Client Engagements &
 * Invoicing, Task 4).
 *
 * Coverage focus (mirrors `billing-rate.service.test.ts`'s mock style):
 *   1. `createEngagement` — company must exist, project_ids must all belong
 *      to the engagement's company, currency is upper-cased, audits on
 *      success.
 *   2. `updateEngagement` — patch-only (untouched fields survive), re-checks
 *      project scope when `project_ids` is part of the patch, audits.
 *   3. `endEngagement` — sets `end_date = today (IST)` + `status = 'ended'`,
 *      idempotent no-op when already ended.
 *   4. `listEngagements` — filters + hydrates the company display batched.
 */

const {
    engagementCreateMock,
    engagementFindByIdMock,
    engagementFindMock,
    engagementCountMock,
    companyExistsMock,
    companyFindMock,
    projectFindMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    engagementCreateMock: vi.fn(),
    engagementFindByIdMock: vi.fn(),
    engagementFindMock: vi.fn(),
    engagementCountMock: vi.fn(),
    companyExistsMock: vi.fn(),
    companyFindMock: vi.fn(),
    projectFindMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/engagement.model.js', () => ({
    Engagement: {
        create: engagementCreateMock,
        findById: engagementFindByIdMock,
        find: engagementFindMock,
        countDocuments: engagementCountMock,
    },
    BILLING_TYPES: ['hourly', 'retainer', 'fixed', 'hybrid'],
    RETAINER_PERIODS: ['month', 'quarter', 'year'],
}));

vi.mock('../models/company.model.js', () => ({
    Company: { exists: companyExistsMock, find: companyFindMock },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { find: projectFindMock },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./engagement.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS } from '../constants/audit.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const todayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

const makeCaller = () => ({ id: new Types.ObjectId(), audit: undefined });

const makeAuditedCaller = () => ({
    id: new Types.ObjectId(),
    audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
});

const makeEngagement = (overrides: Record<string, unknown> = {}) => {
    const e = {
        _id: new Types.ObjectId(),
        company_id: new Types.ObjectId(),
        project_ids: [] as Types.ObjectId[],
        name: 'Acme retainer',
        currency: 'USD',
        billing_type: 'hourly',
        setup_fee: null as number | null,
        retainer_amount: null as number | null,
        retainer_period: null as string | null,
        included_hours: null as number | null,
        fixed_amount: null as number | null,
        start_date: '2026-01-01',
        end_date: null as string | null,
        status: 'active' as string,
        notes: '',
        created_by: new Types.ObjectId(),
        save: vi.fn(),
        toJSON: vi.fn(),
        ...overrides,
    };
    e.save.mockImplementation(async () => e);
    e.toJSON.mockImplementation(() => ({
        id: e._id.toString(),
        company_id: e.company_id.toString(),
        project_ids: e.project_ids.map((id) => id.toString()),
        name: e.name,
        currency: e.currency,
        billing_type: e.billing_type,
        start_date: e.start_date,
        end_date: e.end_date,
        status: e.status,
        notes: e.notes,
    }));
    return e;
};

const stubProjectFind = (rows: { _id: Types.ObjectId; company_id: Types.ObjectId | null }[]): void => {
    projectFindMock.mockReturnValueOnce({
        select: () => ({
            lean: () => Promise.resolve(rows),
        }),
    });
};

beforeEach(() => {
    vi.resetAllMocks();
    companyExistsMock.mockResolvedValue({ _id: new Types.ObjectId() });
    companyFindMock.mockReturnValue({
        select: () => ({
            lean: () => Promise.resolve([]),
        }),
    });
    projectFindMock.mockReturnValue({
        select: () => ({
            lean: () => Promise.resolve([]),
        }),
    });
});

// ─── createEngagement ────────────────────────────────────────────────────

describe('createEngagement', () => {
    const baseBody = (overrides: Record<string, unknown> = {}) => ({
        company_id: new Types.ObjectId().toString(),
        project_ids: [] as string[],
        name: 'Acme retainer',
        currency: 'usd',
        billing_type: 'hourly' as const,
        start_date: '2026-01-01',
        ...overrides,
    });

    it('rejects when the company does not exist', async () => {
        companyExistsMock.mockResolvedValueOnce(null);
        await expect(svc.createEngagement(baseBody(), makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
        });
        expect(engagementCreateMock).not.toHaveBeenCalled();
    });

    it('rejects a project_id not belonging to the company with ENGAGEMENT_INVALID_SCOPE', async () => {
        const companyId = new Types.ObjectId();
        const otherCompanyId = new Types.ObjectId();
        const strayProjectId = new Types.ObjectId();
        stubProjectFind([{ _id: strayProjectId, company_id: otherCompanyId }]);

        await expect(
            svc.createEngagement(
                baseBody({ company_id: companyId.toString(), project_ids: [strayProjectId.toString()] }),
                makeCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.ENGAGEMENT_INVALID_SCOPE });
        expect(engagementCreateMock).not.toHaveBeenCalled();
    });

    it('rejects a project_id that does not exist at all', async () => {
        stubProjectFind([]);
        await expect(
            svc.createEngagement(baseBody({ project_ids: [new Types.ObjectId().toString()] }), makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.PROJECT_NOT_FOUND });
    });

    it('accepts project_ids that all belong to the company', async () => {
        const companyId = new Types.ObjectId();
        const projectId = new Types.ObjectId();
        stubProjectFind([{ _id: projectId, company_id: companyId }]);
        engagementCreateMock.mockResolvedValueOnce(makeEngagement({ company_id: companyId }));

        await expect(
            svc.createEngagement(
                baseBody({ company_id: companyId.toString(), project_ids: [projectId.toString()] }),
                makeCaller()
            )
        ).resolves.toBeTruthy();
        expect(engagementCreateMock).toHaveBeenCalledTimes(1);
    });

    it('upper-cases currency before persisting', async () => {
        engagementCreateMock.mockResolvedValueOnce(makeEngagement());
        await svc.createEngagement(baseBody({ currency: 'usd' }), makeCaller());
        const createArg = engagementCreateMock.mock.calls[0][0] as { currency: string };
        expect(createArg.currency).toBe('USD');
    });

    it('writes an audit row on create', async () => {
        const created = makeEngagement();
        engagementCreateMock.mockResolvedValueOnce(created);

        await svc.createEngagement(baseBody(), makeAuditedCaller());

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [, payload] = recordAuditMock.mock.calls[0] as [unknown, { action: string }];
        expect(payload.action).toBe(AUDIT_ACTIONS.ENGAGEMENT_CREATE);
        expect(payload.action).toBe('engagement.create');
    });

    it('does not audit when the caller has no audit context', async () => {
        engagementCreateMock.mockResolvedValueOnce(makeEngagement());
        await svc.createEngagement(baseBody(), makeCaller());
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── updateEngagement ────────────────────────────────────────────────────

describe('updateEngagement', () => {
    it('is patch-only — untouched fields survive', async () => {
        const engagement = makeEngagement({ name: 'Original name', notes: 'original notes' });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.updateEngagement(engagement._id, { notes: 'updated notes' }, makeCaller());

        expect(engagement.notes).toBe('updated notes');
        expect(engagement.name).toBe('Original name');
        expect(engagement.save).toHaveBeenCalledTimes(1);
    });

    it('re-validates project scope when project_ids is part of the patch', async () => {
        const companyId = new Types.ObjectId();
        const strayProjectId = new Types.ObjectId();
        const otherCompanyId = new Types.ObjectId();
        const engagement = makeEngagement({ company_id: companyId });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);
        stubProjectFind([{ _id: strayProjectId, company_id: otherCompanyId }]);

        await expect(
            svc.updateEngagement(engagement._id, { project_ids: [strayProjectId.toString()] }, makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.ENGAGEMENT_INVALID_SCOPE });
        expect(engagement.save).not.toHaveBeenCalled();
    });

    it('throws ENGAGEMENT_NOT_FOUND when the row does not exist', async () => {
        engagementFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.updateEngagement(new Types.ObjectId(), { notes: 'x' }, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.ENGAGEMENT_NOT_FOUND,
        });
    });

    it('rejects end_date earlier than start_date with ENGAGEMENT_INVALID_RANGE', async () => {
        const engagement = makeEngagement({ start_date: '2026-03-01' });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await expect(
            svc.updateEngagement(engagement._id, { end_date: '2020-01-01' }, makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.ENGAGEMENT_INVALID_RANGE });
        expect(engagement.save).not.toHaveBeenCalled();
        expect(engagement.end_date).toBeNull();
    });

    it('accepts an end_date on or after start_date', async () => {
        const engagement = makeEngagement({ start_date: '2026-03-01' });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.updateEngagement(engagement._id, { end_date: '2026-06-01' }, makeCaller());

        expect(engagement.end_date).toBe('2026-06-01');
        expect(engagement.save).toHaveBeenCalledTimes(1);
    });

    it('allows clearing end_date to null regardless of start_date', async () => {
        const engagement = makeEngagement({ start_date: '2026-03-01', end_date: '2026-06-01' });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.updateEngagement(engagement._id, { end_date: null }, makeCaller());

        expect(engagement.end_date).toBeNull();
        expect(engagement.save).toHaveBeenCalledTimes(1);
    });

    it('audits update with before/after snapshots', async () => {
        const engagement = makeEngagement();
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.updateEngagement(engagement._id, { notes: 'new' }, makeAuditedCaller());

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [, payload] = recordAuditMock.mock.calls[0] as [unknown, { action: string }];
        expect(payload.action).toBe(AUDIT_ACTIONS.ENGAGEMENT_UPDATE);
    });
});

// ─── endEngagement ───────────────────────────────────────────────────────

describe('endEngagement', () => {
    it('sets status to ended and end_date to today (IST)', async () => {
        const engagement = makeEngagement({ status: 'active', end_date: null });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.endEngagement(engagement._id, makeCaller());

        expect(engagement.status).toBe('ended');
        expect(engagement.end_date).toBe(todayLocal());
        expect(engagement.save).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — a no-op when already ended', async () => {
        const engagement = makeEngagement({ status: 'ended', end_date: '2026-02-01' });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.endEngagement(engagement._id, makeCaller());

        expect(engagement.end_date).toBe('2026-02-01');
        expect(engagement.save).not.toHaveBeenCalled();
        expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it('audits the end action', async () => {
        const engagement = makeEngagement({ status: 'active', end_date: null });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.endEngagement(engagement._id, makeAuditedCaller());

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [, payload] = recordAuditMock.mock.calls[0] as [unknown, { action: string }];
        expect(payload.action).toBe(AUDIT_ACTIONS.ENGAGEMENT_END);
    });
});

// ─── listEngagements ─────────────────────────────────────────────────────

describe('listEngagements', () => {
    const stubFind = (rows: ReturnType<typeof makeEngagement>[]): void => {
        engagementFindMock.mockReturnValueOnce({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve(rows),
                }),
            }),
        });
        engagementCountMock.mockResolvedValueOnce(rows.length);
    };

    it('filters by company_id and status', async () => {
        stubFind([]);
        const companyId = new Types.ObjectId().toString();
        await svc.listEngagements({ company_id: companyId, status: 'active', page: 1, limit: 20 });
        const filterArg = engagementFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.company_id).toEqual(new Types.ObjectId(companyId));
        expect(filterArg.status).toBe('active');
    });

    it('hydrates the company display without N+1 (single Company lookup for the page)', async () => {
        const companyId = new Types.ObjectId();
        const row = makeEngagement({ company_id: companyId });
        stubFind([row]);
        companyFindMock.mockReturnValueOnce({
            select: () => ({
                lean: () => Promise.resolve([{ _id: companyId, name: 'Acme Corp' }]),
            }),
        });

        const result = await svc.listEngagements({ page: 1, limit: 20 });

        expect(companyFindMock).toHaveBeenCalledTimes(1);
        expect(result.data[0]).toMatchObject({
            company: { id: companyId.toString(), name: 'Acme Corp' },
        });
        expect(result.meta).toEqual({ page: 1, limit: 20, total: 1, total_pages: 1 });
    });
});

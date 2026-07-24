import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `invoice.service` (Phase 1 — Client Engagements &
 * Invoicing, Task 7). The core billing algorithm: engagement + period →
 * persisted, numbered draft invoice, plus the invoice lifecycle.
 *
 * Coverage focus (brief Step 1):
 *   - generate(hourly): billable minutes per user → one 'hours' line each,
 *     amount = round(minutes/60 * rate, 2); subtotal = Σ; number assigned.
 *   - generate(retainer, no included_hours): single 'retainer' line.
 *   - generate(retainer, included_hours=40, actual=52h): 'retainer' + 'overage'
 *     line for 12h * rate.
 *   - generate(setup_fee set, not yet invoiced): 'setup' line + flips
 *     engagement.setup_fee_invoiced; a second generate does NOT re-add setup.
 *   - generate(fixed): single 'fixed' line = fixed_amount.
 *   - generate overlap: a non-void invoice covers the period + confirm!=true →
 *     INVOICE_PERIOD_OVERLAP; confirm=true proceeds.
 *   - tax math: subtotal 1000, tax_rate 18 → tax_amount 180, total 1180.
 *   - lifecycle: update (draft-only), status transitions, delete (draft-only).
 *
 * `withTransaction` is NOT mocked — with Mongoose unconnected in tests its
 * `readyState !== 1` guard runs the callback bare (no session).
 */

// ─── Hoisted mocks ───────────────────────────────────────────────────────

const {
    engagementFindByIdMock,
    invoiceCreateMock,
    invoiceFindOneMock,
    invoiceFindByIdMock,
    invoiceFindMock,
    invoiceCountMock,
    invoiceDeleteOneMock,
    engagementFindMock,
    timesheetAggregateMock,
    billingRateFindMock,
    projectFindMock,
    companyFindMock,
    companyFindByIdMock,
    nextInvoiceNumberMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    engagementFindByIdMock: vi.fn(),
    engagementFindMock: vi.fn(),
    invoiceCreateMock: vi.fn(),
    invoiceFindOneMock: vi.fn(),
    invoiceFindByIdMock: vi.fn(),
    invoiceFindMock: vi.fn(),
    invoiceCountMock: vi.fn(),
    invoiceDeleteOneMock: vi.fn(),
    timesheetAggregateMock: vi.fn(),
    billingRateFindMock: vi.fn(),
    projectFindMock: vi.fn(),
    companyFindMock: vi.fn(),
    companyFindByIdMock: vi.fn(),
    engagementFindByIdLeanMock: vi.fn(),
    nextInvoiceNumberMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/engagement.model.js', () => ({
    Engagement: {
        // `findById` is polymorphic in the service: generate awaits it for a
        // live doc; getInvoice hydration chains `.select().lean()`. `find`
        // batches names for listInvoices.
        findById: (...args: unknown[]) => engagementFindByIdMock(...args),
        find: (...args: unknown[]) => engagementFindMock(...args),
    },
}));

vi.mock('../models/invoice.model.js', () => ({
    Invoice: {
        create: invoiceCreateMock,
        findOne: invoiceFindOneMock,
        findById: invoiceFindByIdMock,
        find: invoiceFindMock,
        countDocuments: invoiceCountMock,
        deleteOne: invoiceDeleteOneMock,
    },
    INVOICE_STATUSES: ['draft', 'sent', 'paid', 'void'],
    LINE_KINDS: ['hours', 'retainer', 'setup', 'overage', 'fixed', 'manual'],
}));

vi.mock('../models/timesheet-entry.model.js', () => ({
    TimesheetEntry: { aggregate: timesheetAggregateMock },
}));

vi.mock('../models/billing-rate.model.js', () => ({
    BillingRate: {
        find: (filter: unknown) => ({
            select: () => ({
                sort: () => ({
                    lean: () => Promise.resolve(billingRateFindMock(filter) ?? []),
                }),
            }),
        }),
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { find: projectFindMock },
}));

vi.mock('../models/company.model.js', () => ({
    Company: { find: companyFindMock, findById: companyFindByIdMock },
}));

vi.mock('./invoice-number.service.js', () => ({
    nextInvoiceNumber: nextInvoiceNumberMock,
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./invoice.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS } from '../constants/audit.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const makeCaller = () => ({ id: new Types.ObjectId(), audit: undefined });
const makeAuditedCaller = () => ({
    id: new Types.ObjectId(),
    audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
});

const makeEngagement = (overrides: Record<string, unknown> = {}) => {
    const e = {
        _id: new Types.ObjectId(),
        company_id: new Types.ObjectId(),
        project_ids: [new Types.ObjectId()] as Types.ObjectId[],
        name: 'Acme retainer',
        currency: 'EUR',
        billing_type: 'hourly' as string,
        setup_fee: null as number | null,
        setup_fee_invoiced: false,
        retainer_amount: null as number | null,
        retainer_period: null as string | null,
        included_hours: null as number | null,
        fixed_amount: null as number | null,
        start_date: '2026-01-01',
        end_date: null as string | null,
        status: 'active',
        notes: '',
        created_by: new Types.ObjectId(),
        save: vi.fn(),
        ...overrides,
    };
    e.save.mockImplementation(async () => e);
    return e;
};

/**
 * The service calls `Invoice.create([payload], opts)` and takes `[0]`. The
 * returned doc must expose `toJSON`. We capture the payload so tests can
 * assert the computed lines/totals directly.
 */
const wireInvoiceCreate = () => {
    invoiceCreateMock.mockImplementation(async (docs: Record<string, unknown>[]) => {
        const payload = docs[0];
        return [
            {
                _id: new Types.ObjectId(),
                ...payload,
                toJSON: () => ({ id: 'inv', ...payload }),
            },
        ];
    });
};

const lastCreatePayload = (): Record<string, unknown> =>
    (invoiceCreateMock.mock.calls[0][0] as Record<string, unknown>[])[0];

const stubTimesheet = (rows: { _id: Types.ObjectId; billable_minutes: number }[]): void => {
    timesheetAggregateMock.mockResolvedValueOnce(rows);
};

// Project-level rate rows the service resolves per (user). `task_id: null`.
const stubRates = (rows: { user_id: Types.ObjectId; hourly_rate: number }[]): void => {
    billingRateFindMock.mockReturnValueOnce(rows.map((r) => ({ ...r, task_id: null, effective_from: '2026-01-01' })));
};

const baseGenBody = (overrides: Record<string, unknown> = {}) => ({
    engagement_id: new Types.ObjectId().toString(),
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    ...overrides,
});

beforeEach(() => {
    vi.resetAllMocks();
    // Defaults: no overlap, number minted, empty timesheet/rates.
    invoiceFindOneMock.mockResolvedValue(null);
    nextInvoiceNumberMock.mockResolvedValue('INV-2026-0001');
    timesheetAggregateMock.mockResolvedValue([]);
    billingRateFindMock.mockReturnValue([]);
    projectFindMock.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
    wireInvoiceCreate();
});

// ─── generateInvoice — hourly ────────────────────────────────────────────

describe('generateInvoice — hourly', () => {
    it('builds one hours line per user, amount = round(minutes/60 * rate, 2)', async () => {
        const userA = new Types.ObjectId();
        const userB = new Types.ObjectId();
        const engagement = makeEngagement({ billing_type: 'hourly' });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);
        stubTimesheet([
            { _id: userA, billable_minutes: 600 }, // 10h
            { _id: userB, billable_minutes: 90 }, // 1.5h
        ]);
        stubRates([
            { user_id: userA, hourly_rate: 100 },
            { user_id: userB, hourly_rate: 80 },
        ]);

        await svc.generateInvoice(baseGenBody(), makeCaller());

        const payload = lastCreatePayload();
        const lines = payload.line_items as { kind: string; user_id: Types.ObjectId; amount: number }[];
        expect(lines).toHaveLength(2);
        expect(lines.every((l) => l.kind === 'hours')).toBe(true);
        const amounts = lines.map((l) => l.amount).sort((a, b) => a - b);
        expect(amounts).toEqual([120, 1000]); // 1.5*80=120, 10*100=1000
        expect(payload.subtotal).toBe(1120);
        expect(payload.total).toBe(1120);
        expect(payload.number).toBe('INV-2026-0001');
        expect(payload.status).toBe('draft');
        // year(period_end), default prefix (undefined), no session in tests
        expect(nextInvoiceNumberMock).toHaveBeenCalledWith(2026, undefined, undefined);
    });

    it('a user with no matching rate contributes a line with rate null and amount 0', async () => {
        const userA = new Types.ObjectId();
        const engagement = makeEngagement({ billing_type: 'hourly' });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);
        stubTimesheet([{ _id: userA, billable_minutes: 600 }]);
        stubRates([]); // no rate

        await svc.generateInvoice(baseGenBody(), makeCaller());

        const line = (lastCreatePayload().line_items as { rate: number | null; amount: number }[])[0];
        expect(line.rate).toBeNull();
        expect(line.amount).toBe(0);
        expect(lastCreatePayload().subtotal).toBe(0);
    });
});

// ─── generateInvoice — retainer ──────────────────────────────────────────

describe('generateInvoice — retainer', () => {
    it('no included_hours → single retainer line = retainer_amount', async () => {
        const engagement = makeEngagement({
            billing_type: 'retainer',
            retainer_amount: 5000,
            retainer_period: 'month',
            included_hours: null,
        });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.generateInvoice(baseGenBody(), makeCaller());

        const lines = lastCreatePayload().line_items as { kind: string; amount: number }[];
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ kind: 'retainer', amount: 5000 });
        expect(lastCreatePayload().subtotal).toBe(5000);
        // no hourly component fired for a pure retainer
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
    });

    it('included_hours=40, actual=52h → retainer line + overage line for 12h * rate', async () => {
        const userA = new Types.ObjectId();
        const engagement = makeEngagement({
            billing_type: 'retainer',
            retainer_amount: 5000,
            retainer_period: 'month',
            included_hours: 40,
        });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);
        stubTimesheet([{ _id: userA, billable_minutes: 52 * 60 }]); // 52h
        stubRates([{ user_id: userA, hourly_rate: 100 }]);

        await svc.generateInvoice(baseGenBody(), makeCaller());

        const lines = lastCreatePayload().line_items as { kind: string; amount: number; quantity_minutes: number }[];
        expect(lines).toHaveLength(2);
        const retainer = lines.find((l) => l.kind === 'retainer');
        const overage = lines.find((l) => l.kind === 'overage');
        expect(retainer?.amount).toBe(5000);
        expect(overage?.amount).toBe(1200); // 12h * 100
        expect(overage?.quantity_minutes).toBe(12 * 60);
        expect(lastCreatePayload().subtotal).toBe(6200);
    });

    it('included_hours set but actual <= included → no overage line', async () => {
        const userA = new Types.ObjectId();
        const engagement = makeEngagement({
            billing_type: 'retainer',
            retainer_amount: 5000,
            retainer_period: 'month',
            included_hours: 40,
        });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);
        stubTimesheet([{ _id: userA, billable_minutes: 30 * 60 }]); // 30h < 40
        stubRates([{ user_id: userA, hourly_rate: 100 }]);

        await svc.generateInvoice(baseGenBody(), makeCaller());

        const lines = lastCreatePayload().line_items as { kind: string }[];
        expect(lines).toHaveLength(1);
        expect(lines[0].kind).toBe('retainer');
    });
});

// ─── generateInvoice — setup fee (bill-once) ─────────────────────────────

describe('generateInvoice — setup fee', () => {
    it('adds a setup line and flips setup_fee_invoiced when not yet invoiced', async () => {
        const engagement = makeEngagement({
            billing_type: 'fixed',
            fixed_amount: 10000,
            setup_fee: 2000,
            setup_fee_invoiced: false,
        });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.generateInvoice(baseGenBody(), makeCaller());

        const lines = lastCreatePayload().line_items as { kind: string; amount: number }[];
        expect(lines.find((l) => l.kind === 'setup')).toMatchObject({ amount: 2000 });
        expect(engagement.setup_fee_invoiced).toBe(true);
        expect(engagement.save).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-add setup on a second generate (already invoiced)', async () => {
        const engagement = makeEngagement({
            billing_type: 'fixed',
            fixed_amount: 10000,
            setup_fee: 2000,
            setup_fee_invoiced: true,
        });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.generateInvoice(baseGenBody(), makeCaller());

        const lines = lastCreatePayload().line_items as { kind: string }[];
        expect(lines.find((l) => l.kind === 'setup')).toBeUndefined();
        expect(engagement.save).not.toHaveBeenCalled();
    });
});

// ─── generateInvoice — fixed ─────────────────────────────────────────────

describe('generateInvoice — fixed', () => {
    it('single fixed line = fixed_amount', async () => {
        const engagement = makeEngagement({ billing_type: 'fixed', fixed_amount: 12500 });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.generateInvoice(baseGenBody(), makeCaller());

        const lines = lastCreatePayload().line_items as { kind: string; amount: number }[];
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ kind: 'fixed', amount: 12500 });
    });
});

// ─── generateInvoice — overlap guard ─────────────────────────────────────

describe('generateInvoice — overlap guard', () => {
    it('throws INVOICE_PERIOD_OVERLAP when a non-void invoice overlaps and confirm is not set', async () => {
        const engagement = makeEngagement({ billing_type: 'fixed', fixed_amount: 100 });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);
        invoiceFindOneMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });

        await expect(svc.generateInvoice(baseGenBody(), makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.INVOICE_PERIOD_OVERLAP,
        });
        expect(invoiceCreateMock).not.toHaveBeenCalled();
    });

    it('proceeds when confirm=true despite an overlap', async () => {
        const engagement = makeEngagement({ billing_type: 'fixed', fixed_amount: 100 });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);
        invoiceFindOneMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });

        await svc.generateInvoice(baseGenBody({ confirm: true }), makeCaller());
        expect(invoiceCreateMock).toHaveBeenCalledTimes(1);
    });

    it('the overlap query excludes void invoices and uses inclusive period bounds', async () => {
        const engagement = makeEngagement({ billing_type: 'fixed', fixed_amount: 100 });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.generateInvoice(baseGenBody({ period_start: '2026-06-01', period_end: '2026-06-30' }), makeCaller());

        const filter = invoiceFindOneMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.status).toEqual({ $ne: 'void' });
        expect(filter.period_start).toEqual({ $lte: '2026-06-30' });
        expect(filter.period_end).toEqual({ $gte: '2026-06-01' });
    });
});

// ─── generateInvoice — resolves company projects when scope empty ────────

describe('generateInvoice — project scope', () => {
    it('resolves all company projects when engagement.project_ids is empty', async () => {
        const companyId = new Types.ObjectId();
        const p1 = new Types.ObjectId();
        const p2 = new Types.ObjectId();
        const engagement = makeEngagement({ billing_type: 'hourly', company_id: companyId, project_ids: [] });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);
        projectFindMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve([{ _id: p1 }, { _id: p2 }]) }),
        });

        await svc.generateInvoice(baseGenBody(), makeCaller());

        expect(projectFindMock).toHaveBeenCalledWith({ company_id: companyId });
        // snapshot carries the resolved project ids
        const payload = lastCreatePayload();
        expect((payload.project_ids as Types.ObjectId[]).map((id) => id.toString()).sort()).toEqual(
            [p1.toString(), p2.toString()].sort()
        );
    });
});

// ─── generateInvoice — 404 + audit ───────────────────────────────────────

describe('generateInvoice — misc', () => {
    it('throws ENGAGEMENT_NOT_FOUND when the engagement does not exist', async () => {
        engagementFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.generateInvoice(baseGenBody(), makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.ENGAGEMENT_NOT_FOUND,
        });
    });

    it('audits invoice.generate', async () => {
        const engagement = makeEngagement({ billing_type: 'fixed', fixed_amount: 100 });
        engagementFindByIdMock.mockResolvedValueOnce(engagement);

        await svc.generateInvoice(baseGenBody(), makeAuditedCaller());

        const [, payload] = recordAuditMock.mock.calls[0] as [unknown, { action: string }];
        expect(payload.action).toBe(AUDIT_ACTIONS.INVOICE_GENERATE);
        expect(payload.action).toBe('invoice.generate');
    });
});

// ─── updateInvoice ───────────────────────────────────────────────────────

const makeInvoiceDoc = (overrides: Record<string, unknown> = {}) => {
    const inv = {
        _id: new Types.ObjectId(),
        number: 'INV-2026-0001',
        company_id: new Types.ObjectId(),
        engagement_id: new Types.ObjectId(),
        project_ids: [] as Types.ObjectId[],
        period_start: '2026-06-01',
        period_end: '2026-06-30',
        currency: 'EUR',
        line_items: [] as unknown[],
        subtotal: 0,
        tax_rate: 0,
        tax_label: 'No tax',
        tax_amount: 0,
        total: 0,
        status: 'draft',
        issue_date: null as string | null,
        due_date: null as string | null,
        paid_date: null as string | null,
        notes: '',
        created_by: new Types.ObjectId(),
        save: vi.fn(),
        deleteOne: vi.fn(),
        ...overrides,
    };
    inv.save.mockImplementation(async () => inv);
    (inv as Record<string, unknown>).toJSON = () => ({ id: inv._id.toString(), ...inv });
    return inv;
};

describe('updateInvoice', () => {
    it('recomputes subtotal/tax/total from incoming line_items (tax math)', async () => {
        const inv = makeInvoiceDoc({ status: 'draft' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);

        await svc.updateInvoice(
            inv._id,
            {
                line_items: [{ kind: 'manual', description: 'Consulting', amount: 1000 }],
                tax_rate: 18,
                tax_label: 'IGST 18%',
            },
            makeCaller()
        );

        expect(inv.subtotal).toBe(1000);
        expect(inv.tax_amount).toBe(180);
        expect(inv.total).toBe(1180);
        expect(inv.save).toHaveBeenCalledTimes(1);
    });

    it('supports a negative manual line (discount)', async () => {
        const inv = makeInvoiceDoc({ status: 'draft' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);

        await svc.updateInvoice(
            inv._id,
            {
                line_items: [
                    { kind: 'fixed', description: 'Project fee', amount: 1000 },
                    { kind: 'manual', description: 'Loyalty discount', amount: -100 },
                ],
            },
            makeCaller()
        );

        expect(inv.subtotal).toBe(900);
        expect(inv.total).toBe(900);
    });

    it('refuses to edit a non-draft invoice with INVOICE_NOT_DRAFT', async () => {
        const inv = makeInvoiceDoc({ status: 'sent' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await expect(svc.updateInvoice(inv._id, { notes: 'x' }, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.INVOICE_NOT_DRAFT,
        });
        expect(inv.save).not.toHaveBeenCalled();
    });

    it('throws INVOICE_NOT_FOUND when the invoice does not exist', async () => {
        invoiceFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.updateInvoice(new Types.ObjectId(), { notes: 'x' }, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.INVOICE_NOT_FOUND,
        });
    });

    it('audits invoice.update', async () => {
        const inv = makeInvoiceDoc({ status: 'draft' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await svc.updateInvoice(inv._id, { notes: 'hello' }, makeAuditedCaller());
        const [, payload] = recordAuditMock.mock.calls[0] as [unknown, { action: string }];
        expect(payload.action).toBe(AUDIT_ACTIONS.INVOICE_UPDATE);
    });
});

// ─── setInvoiceStatus ────────────────────────────────────────────────────

describe('setInvoiceStatus', () => {
    it('draft → sent sets issue_date', async () => {
        const inv = makeInvoiceDoc({ status: 'draft' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await svc.setInvoiceStatus(inv._id, 'sent', {}, makeCaller());
        expect(inv.status).toBe('sent');
        expect(inv.issue_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('sent → paid sets paid_date (from extra when provided)', async () => {
        const inv = makeInvoiceDoc({ status: 'sent' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await svc.setInvoiceStatus(inv._id, 'paid', { paid_date: '2026-07-10' }, makeCaller());
        expect(inv.status).toBe('paid');
        expect(inv.paid_date).toBe('2026-07-10');
    });

    it('any non-void → void is allowed', async () => {
        const inv = makeInvoiceDoc({ status: 'paid' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await svc.setInvoiceStatus(inv._id, 'void', {}, makeCaller());
        expect(inv.status).toBe('void');
    });

    it('draft → paid is illegal (INVOICE_INVALID_TRANSITION)', async () => {
        const inv = makeInvoiceDoc({ status: 'draft' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await expect(svc.setInvoiceStatus(inv._id, 'paid', {}, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.INVOICE_INVALID_TRANSITION,
        });
        expect(inv.save).not.toHaveBeenCalled();
    });

    it('void → sent is illegal', async () => {
        const inv = makeInvoiceDoc({ status: 'void' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await expect(svc.setInvoiceStatus(inv._id, 'sent', {}, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.INVOICE_INVALID_TRANSITION,
        });
    });

    it('audits invoice.status with from/to metadata', async () => {
        const inv = makeInvoiceDoc({ status: 'draft' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await svc.setInvoiceStatus(inv._id, 'sent', {}, makeAuditedCaller());
        const [, payload] = recordAuditMock.mock.calls[0] as [
            unknown,
            { action: string; metadata?: Record<string, unknown> },
        ];
        expect(payload.action).toBe(AUDIT_ACTIONS.INVOICE_STATUS);
        expect(payload.metadata).toMatchObject({ from: 'draft', to: 'sent' });
    });
});

// ─── deleteInvoice ───────────────────────────────────────────────────────

describe('deleteInvoice', () => {
    it('deletes a draft invoice', async () => {
        const inv = makeInvoiceDoc({ status: 'draft' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await svc.deleteInvoice(inv._id, makeCaller());
        expect(inv.deleteOne).toHaveBeenCalledTimes(1);
    });

    it('refuses to delete a non-draft invoice with INVOICE_NOT_DRAFT', async () => {
        const inv = makeInvoiceDoc({ status: 'sent' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        await expect(svc.deleteInvoice(inv._id, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.INVOICE_NOT_DRAFT,
        });
        expect(inv.deleteOne).not.toHaveBeenCalled();
    });
});

// ─── getInvoice / listInvoices hydration ─────────────────────────────────

describe('getInvoice', () => {
    it('hydrates company + engagement name', async () => {
        const inv = makeInvoiceDoc({ status: 'draft' });
        invoiceFindByIdMock.mockResolvedValueOnce(inv);
        companyFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ _id: inv.company_id, name: 'Acme Corp' }) }),
        });
        engagementFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ _id: inv.engagement_id, name: 'Acme Retainer' }) }),
        });

        const result = await svc.getInvoice(inv._id);
        expect(result).toMatchObject({
            company: { id: inv.company_id.toString(), name: 'Acme Corp' },
            engagement: { id: inv.engagement_id.toString(), name: 'Acme Retainer' },
        });
    });

    it('throws INVOICE_NOT_FOUND when missing', async () => {
        invoiceFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.getInvoice(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.INVOICE_NOT_FOUND,
        });
    });
});

describe('listInvoices', () => {
    const stubList = (rows: ReturnType<typeof makeInvoiceDoc>[]): void => {
        invoiceFindMock.mockReturnValueOnce({
            sort: () => ({ skip: () => ({ limit: () => Promise.resolve(rows) }) }),
        });
        invoiceCountMock.mockResolvedValueOnce(rows.length);
    };

    it('filters by company_id / engagement_id / status', async () => {
        stubList([]);
        companyFindMock.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve([]) }) });
        engagementFindMock.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
        const companyId = new Types.ObjectId().toString();
        const engagementId = new Types.ObjectId().toString();
        await svc.listInvoices({
            company_id: companyId,
            engagement_id: engagementId,
            status: 'sent',
            page: 1,
            limit: 20,
        });
        const filter = invoiceFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.company_id).toEqual(new Types.ObjectId(companyId));
        expect(filter.engagement_id).toEqual(new Types.ObjectId(engagementId));
        expect(filter.status).toBe('sent');
    });

    it('hydrates company + engagement names batched and returns pagination meta', async () => {
        const companyId = new Types.ObjectId();
        const engagementId = new Types.ObjectId();
        const row = makeInvoiceDoc({ company_id: companyId, engagement_id: engagementId });
        stubList([row]);
        companyFindMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve([{ _id: companyId, name: 'Acme Corp' }]) }),
        });
        // batched engagement hydration via Engagement.find
        engagementFindMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve([{ _id: engagementId, name: 'Acme Retainer' }]) }),
        });

        const result = await svc.listInvoices({ page: 1, limit: 20 });

        expect(result.data[0]).toMatchObject({ company: { id: companyId.toString(), name: 'Acme Corp' } });
        expect(result.meta).toEqual({ page: 1, limit: 20, total: 1, total_pages: 1 });
    });
});

// src/routes/invoice.routes.test.ts
//
// HTTP-level tests for `/api/v1/invoices/*` proving the routes are gated
// purely by `invoice.read`/`invoice.write` PERMISSIONs, not by role.
//
// Harness mirrors payslip.routes.test.ts / billing-rate route tests: real
// JWTs signed with the test JWT secret drive the full
// authenticate → requirePermission → validate chain; only the invoice
// service and the User model (read by `authenticate`) are mocked.

// These suites exercise the billing module's real behaviour, so they run with
// the feature gate ON. `vi.hoisted` is the only hook that fires before the
// import graph, and `server.config` parses this flag once at module load — a
// plain assignment here would run after the config was already frozen.
vi.hoisted(() => {
    process.env.BILLING_MODULES_ENABLED = 'true';
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// ─── Hoisted mock factories ───────────────────────────────────────────────

const {
    generateInvoiceMock,
    getInvoiceMock,
    listInvoicesMock,
    updateInvoiceMock,
    setInvoiceStatusMock,
    deleteInvoiceMock,
    userFindByIdMock,
    settingsMock,
} = vi.hoisted(() => ({
    generateInvoiceMock: vi.fn(),
    getInvoiceMock: vi.fn(),
    listInvoicesMock: vi.fn(),
    updateInvoiceMock: vi.fn(),
    setInvoiceStatusMock: vi.fn(),
    deleteInvoiceMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    settingsMock: vi.fn(),
}));

// ─── Module mocks (must be before any imports that load these) ───────────

vi.mock('../services/invoice.service.js', () => ({
    generateInvoice: generateInvoiceMock,
    getInvoice: getInvoiceMock,
    listInvoices: listInvoicesMock,
    updateInvoice: updateInvoiceMock,
    setInvoiceStatus: setInvoiceStatusMock,
    deleteInvoice: deleteInvoiceMock,
}));

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock },
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
    resolveLoginLockoutPolicy: vi.fn().mockResolvedValue({
        failed_login_threshold: null,
        lockout_duration_minutes: null,
    }),
}));

// ─── App under test ───────────────────────────────────────────────────────

const { buildTestApp } = await import('../integration/_helpers/build-app.js');
const app = buildTestApp();

// ─── JWT helpers ──────────────────────────────────────────────────────────

const TEST_SECRET = process.env.JWT_SECRET ?? 'test-secret';

const issueToken = (
    overrides: {
        user_id?: string;
        role?: string;
        permissions?: string[];
        role_keys?: string[];
    } = {}
): string =>
    jwt.sign(
        {
            user_id: overrides.user_id ?? new Types.ObjectId().toString(),
            role: overrides.role ?? 'employee',
            role_keys: overrides.role_keys ?? [overrides.role ?? 'employee'],
            permissions: overrides.permissions ?? [],
        },
        TEST_SECRET,
        { expiresIn: '1h' }
    );

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

const VALID_ID = '5f'.padEnd(24, '0');

const VALID_GENERATE_BODY = {
    engagement_id: '5f'.padEnd(24, '1'),
    period_start: '2026-06-01',
    period_end: '2026-06-30',
};

const STUB_INVOICE = { _id: VALID_ID, number: 'INV-2026-0001', status: 'draft', total: 1000 };

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.resetAllMocks();

    // Auth middleware does a User.findById → select → lean per request.
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
    });

    settingsMock.mockResolvedValue({
        security: { require_mfa_for_admins: false },
    });

    generateInvoiceMock.mockResolvedValue(STUB_INVOICE);
    getInvoiceMock.mockResolvedValue(STUB_INVOICE);
    listInvoicesMock.mockResolvedValue({
        data: [STUB_INVOICE],
        meta: { page: 1, limit: 20, total: 1, total_pages: 1 },
    });
    updateInvoiceMock.mockResolvedValue({ ...STUB_INVOICE, notes: 'updated' });
    setInvoiceStatusMock.mockResolvedValue({ ...STUB_INVOICE, status: 'sent' });
    deleteInvoiceMock.mockResolvedValue(undefined);
});

// ─── POST /invoices/generate ────────────────────────────────────────────

describe('POST /api/v1/invoices/generate', () => {
    it('403s a token that lacks invoice.write', async () => {
        const token = issueToken({ role: 'employee', permissions: ['invoice.read'] });

        const res = await request(app)
            .post('/api/v1/invoices/generate')
            .set(authHeader(token))
            .send(VALID_GENERATE_BODY);

        expect(res.status).toBe(403);
        expect(generateInvoiceMock).not.toHaveBeenCalled();
    });

    it('201s + returns data.number for a token that holds invoice.write', async () => {
        const token = issueToken({ role: 'manager', permissions: ['invoice.write'] });

        const res = await request(app)
            .post('/api/v1/invoices/generate')
            .set(authHeader(token))
            .send(VALID_GENERATE_BODY);

        expect(res.status).toBe(201);
        expect(res.body.data.number).toBe(STUB_INVOICE.number);
        expect(generateInvoiceMock).toHaveBeenCalledOnce();
    });

    it('400s an invalid body even with a valid permission (validate middleware still runs)', async () => {
        const token = issueToken({ role: 'manager', permissions: ['invoice.write'] });

        const res = await request(app)
            .post('/api/v1/invoices/generate')
            .set(authHeader(token))
            .send({ ...VALID_GENERATE_BODY, period_start: 'not-a-date' });

        expect([400, 422]).toContain(res.status);
        expect(generateInvoiceMock).not.toHaveBeenCalled();
    });

    it('401s without auth', async () => {
        const res = await request(app).post('/api/v1/invoices/generate').send(VALID_GENERATE_BODY);

        expect(res.status).toBe(401);
        expect(generateInvoiceMock).not.toHaveBeenCalled();
    });
});

// ─── GET /invoices ───────────────────────────────────────────────────────

describe('GET /api/v1/invoices', () => {
    it('403s a token that lacks invoice.read', async () => {
        const token = issueToken({ role: 'employee', permissions: [] });

        const res = await request(app).get('/api/v1/invoices').set(authHeader(token));

        expect(res.status).toBe(403);
        expect(listInvoicesMock).not.toHaveBeenCalled();
    });

    it('200s with data + meta for a token that holds invoice.read', async () => {
        const token = issueToken({ role: 'manager', permissions: ['invoice.read'] });

        const res = await request(app).get('/api/v1/invoices').set(authHeader(token));

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.meta.total).toBe(1);
        expect(listInvoicesMock).toHaveBeenCalledOnce();
    });
});

// ─── GET /invoices/:id ───────────────────────────────────────────────────

describe('GET /api/v1/invoices/:id', () => {
    it('403s a token that lacks invoice.read', async () => {
        const token = issueToken({ role: 'employee', permissions: [] });

        const res = await request(app).get(`/api/v1/invoices/${VALID_ID}`).set(authHeader(token));

        expect(res.status).toBe(403);
        expect(getInvoiceMock).not.toHaveBeenCalled();
    });

    it('200s for a token that holds invoice.read', async () => {
        const token = issueToken({ role: 'manager', permissions: ['invoice.read'] });

        const res = await request(app).get(`/api/v1/invoices/${VALID_ID}`).set(authHeader(token));

        expect(res.status).toBe(200);
        expect(res.body.data.number).toBe(STUB_INVOICE.number);
        expect(getInvoiceMock).toHaveBeenCalledOnce();
    });

    it('400s an invalid ObjectId path param', async () => {
        const token = issueToken({ role: 'manager', permissions: ['invoice.read'] });

        const res = await request(app).get('/api/v1/invoices/not-an-id').set(authHeader(token));

        expect([400, 422]).toContain(res.status);
        expect(getInvoiceMock).not.toHaveBeenCalled();
    });
});

// ─── PATCH /invoices/:id ─────────────────────────────────────────────────

describe('PATCH /api/v1/invoices/:id', () => {
    it('403s a token that lacks invoice.write', async () => {
        const token = issueToken({ role: 'employee', permissions: ['invoice.read'] });

        const res = await request(app)
            .patch(`/api/v1/invoices/${VALID_ID}`)
            .set(authHeader(token))
            .send({ notes: 'hi' });

        expect(res.status).toBe(403);
        expect(updateInvoiceMock).not.toHaveBeenCalled();
    });

    it('200s for a token that holds invoice.write', async () => {
        const token = issueToken({ role: 'manager', permissions: ['invoice.write'] });

        const res = await request(app)
            .patch(`/api/v1/invoices/${VALID_ID}`)
            .set(authHeader(token))
            .send({ notes: 'hi' });

        expect(res.status).toBe(200);
        expect(updateInvoiceMock).toHaveBeenCalledOnce();
    });
});

// ─── POST /invoices/:id/status ───────────────────────────────────────────

describe('POST /api/v1/invoices/:id/status', () => {
    it('403s a token that lacks invoice.write', async () => {
        const token = issueToken({ role: 'employee', permissions: ['invoice.read'] });

        const res = await request(app)
            .post(`/api/v1/invoices/${VALID_ID}/status`)
            .set(authHeader(token))
            .send({ to: 'sent' });

        expect(res.status).toBe(403);
        expect(setInvoiceStatusMock).not.toHaveBeenCalled();
    });

    it('200s for a token that holds invoice.write and maps `to`/`paid_date` through', async () => {
        const token = issueToken({ role: 'manager', permissions: ['invoice.write'] });

        const res = await request(app)
            .post(`/api/v1/invoices/${VALID_ID}/status`)
            .set(authHeader(token))
            .send({ to: 'paid', paid_date: '2026-07-01' });

        expect(res.status).toBe(200);
        expect(setInvoiceStatusMock).toHaveBeenCalledOnce();
        const [, to, extra] = setInvoiceStatusMock.mock.calls[0] as [unknown, string, { paid_date?: string }];
        expect(to).toBe('paid');
        expect(extra).toEqual({ paid_date: '2026-07-01' });
    });
});

// ─── DELETE /invoices/:id ────────────────────────────────────────────────

describe('DELETE /api/v1/invoices/:id', () => {
    it('403s a token that lacks invoice.write', async () => {
        const token = issueToken({ role: 'employee', permissions: ['invoice.read'] });

        const res = await request(app).delete(`/api/v1/invoices/${VALID_ID}`).set(authHeader(token));

        expect(res.status).toBe(403);
        expect(deleteInvoiceMock).not.toHaveBeenCalled();
    });

    it('204s for a token that holds invoice.write', async () => {
        const token = issueToken({ role: 'manager', permissions: ['invoice.write'] });

        const res = await request(app).delete(`/api/v1/invoices/${VALID_ID}`).set(authHeader(token));

        expect(res.status).toBe(204);
        expect(deleteInvoiceMock).toHaveBeenCalledOnce();
    });

    it('401s without auth', async () => {
        const res = await request(app).delete(`/api/v1/invoices/${VALID_ID}`);

        expect(res.status).toBe(401);
        expect(deleteInvoiceMock).not.toHaveBeenCalled();
    });
});

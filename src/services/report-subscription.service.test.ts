import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS } from '../constants/audit.js';
import { USER_STATUSES } from '../constants/user-statuses.js';

/**
 * Unit tests for `report-subscription.service` (Phase 4 Step 43).
 *
 * Coverage focus:
 *   1. **Owner scoping** — every read/write filters by user_id;
 *      cross-user IDs surface as REPORT_SUBSCRIPTION_NOT_FOUND.
 *   2. **Per-user cap = 20** enforced before create.
 *   3. **Filter dispatch** validates against the matching report
 *      schema; `filters.` path prefix on errors.
 *   4. **Schedule semantics in the sweep** — fires only on matching
 *      day_of_week, skips already-sent-today, skips inactive,
 *      skips deactivated owner.
 *   5. **Atomic CAS on last_sent_at** — race-loss surfaces as a
 *      failure (not silent).
 *   6. **Audit emissions** — create/update/delete from caller
 *      context, send from system context.
 */

const {
    subCreateMock,
    subFindOneMock,
    subFindOneAndUpdateMock,
    subFindMock,
    subCountMock,
    userFindByIdMock,
    sendEmailMock,
    buildBillingMock,
    buildUtilizationMock,
    buildAttendanceMock,
    buildLeaveMock,
    recordAuditMock,
    recordSystemAuditMock,
} = vi.hoisted(() => ({
    subCreateMock: vi.fn(),
    subFindOneMock: vi.fn(),
    subFindOneAndUpdateMock: vi.fn(),
    subFindMock: vi.fn(),
    subCountMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    sendEmailMock: vi.fn(),
    buildBillingMock: vi.fn(),
    buildUtilizationMock: vi.fn(),
    buildAttendanceMock: vi.fn(),
    buildLeaveMock: vi.fn(),
    recordAuditMock: vi.fn(),
    recordSystemAuditMock: vi.fn(),
}));

vi.mock('../models/report-subscription.model.js', () => ({
    ReportSubscription: {
        create: subCreateMock,
        findOne: subFindOneMock,
        findOneAndUpdate: subFindOneAndUpdateMock,
        find: subFindMock,
        countDocuments: subCountMock,
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock },
}));

vi.mock('../utils/mailer.js', () => ({
    sendEmail: sendEmailMock,
}));

vi.mock('./report.service.js', () => ({
    buildBillingReport: buildBillingMock,
    buildUtilizationReport: buildUtilizationMock,
    buildAttendanceReport: buildAttendanceMock,
    buildLeaveReport: buildLeaveMock,
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: recordSystemAuditMock,
}));

const svc = await import('./report-subscription.service.js');

// ─── Helpers ───────────────────────────────────────────────────────────

const queryStub = (rows: unknown[]) => {
    const stub: Record<string, unknown> = {
        sort: () => stub,
        skip: () => stub,
        limit: () => stub,
        then: (r: (v: unknown) => void) => Promise.resolve(rows).then(r),
    };
    return stub;
};

const sweepStub = (rows: unknown[]) => ({
    limit: () => sweepStub(rows),
    exec: () => Promise.resolve(rows),
});

const findByIdStub = (row: unknown) => ({
    select: () => findByIdStub(row),
    lean: () => Promise.resolve(row),
});

const callerId = () => new Types.ObjectId();
const callerAudit = () => ({
    actor_id: new Types.ObjectId(),
    actor_role: 'admin' as const,
    ip: null,
    user_agent: null,
    request_id: null,
});

const validBillingFilters = () => ({
    project_id: 'a'.repeat(24),
    from_date: '2026-04-01',
    to_date: '2026-04-30',
});

const validBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Weekly billing',
    report_name: 'billing' as const,
    filters: validBillingFilters(),
    day_of_week: 1, // Monday
    hour_local: 7,
    is_active: true,
    ...overrides,
});

const makeSubDoc = (overrides: Record<string, unknown> = {}) => {
    const _id = new Types.ObjectId();
    const doc = {
        _id,
        user_id: new Types.ObjectId(),
        name: 'Weekly billing',
        report_name: 'billing',
        filters: validBillingFilters(),
        day_of_week: 1,
        hour_local: 7,
        is_active: true,
        last_sent_at: null,
        save: vi.fn(),
        deleteOne: vi.fn(),
        toJSON: vi.fn(),
        ...overrides,
    };
    doc.save.mockImplementation(async () => doc);
    doc.deleteOne.mockImplementation(async () => ({}));
    doc.toJSON.mockImplementation(() => ({ id: _id.toString(), ...doc }));
    return doc;
};

const billingResultFixture = () => ({
    project: { id: 'p1', name: 'Apollo' },
    from_date: '2026-04-01',
    to_date: '2026-04-30',
    rows: [],
    totals: { billable_minutes: 0, non_billable_minutes: 0, billable_amount: 0 },
});

beforeEach(() => {
    vi.resetAllMocks();
    subCountMock.mockResolvedValue(0);
    sendEmailMock.mockResolvedValue(undefined);
    recordAuditMock.mockResolvedValue(undefined);
    recordSystemAuditMock.mockResolvedValue(undefined);
});

// ─── createSubscription ────────────────────────────────────────────────

describe('createSubscription', () => {
    it('happy path: creates with caller as user_id, audits create', async () => {
        const caller = callerId();
        const doc = makeSubDoc({ user_id: caller });
        subCreateMock.mockResolvedValueOnce(doc);

        const result = await svc.createSubscription(validBody(), caller, callerAudit());

        expect(subCreateMock).toHaveBeenCalledTimes(1);
        const arg = subCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.user_id).toBe(caller);
        expect(arg.day_of_week).toBe(1);
        expect(result).toBeDefined();

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const audit = recordAuditMock.mock.calls[0][1] as { action: string };
        expect(audit.action).toBe(AUDIT_ACTIONS.REPORT_SUBSCRIPTION_CREATE);
    });

    it('rejects with REPORT_SUBSCRIPTION_LIMIT_EXCEEDED at 20 subscriptions', async () => {
        subCountMock.mockResolvedValueOnce(20);
        await expect(svc.createSubscription(validBody(), callerId(), undefined)).rejects.toMatchObject({
            code: ERROR_CODES.REPORT_SUBSCRIPTION_LIMIT_EXCEEDED,
        });
        expect(subCreateMock).not.toHaveBeenCalled();
    });

    it('rejects malformed filters with VALIDATION_ERROR (per-report dispatch)', async () => {
        const bad = validBody({ filters: { from_date: '2026-04-01', to_date: '2026-04-30' } }); // missing project_id
        await expect(svc.createSubscription(bad, callerId(), undefined)).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
    });

    it('error path is prefixed with `filters.` (FE form-routing UX)', async () => {
        const bad = validBody({ filters: { from_date: '2026-04-01', to_date: '2026-04-30' } });
        let caught: { details?: { errors?: { field: string }[] } } | undefined;
        await svc.createSubscription(bad, callerId(), undefined).catch((err: unknown) => {
            caught = err as typeof caught;
        });
        const fields = caught?.details?.errors?.map((e) => e.field) ?? [];
        expect(fields.length).toBeGreaterThan(0);
        expect(fields.every((f) => f.startsWith('filters'))).toBe(true);
    });

    it('maps E11000 unique-index collision to DUPLICATE_RESOURCE', async () => {
        const dupErr = Object.assign(new Error('E11000'), { code: 11000 });
        subCreateMock.mockRejectedValueOnce(dupErr);
        await expect(svc.createSubscription(validBody(), callerId(), undefined)).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
        });
    });

    it('skips audit when no audit context provided', async () => {
        const doc = makeSubDoc();
        subCreateMock.mockResolvedValueOnce(doc);
        await svc.createSubscription(validBody(), callerId(), undefined);
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── owner-scoping CRUD reads ──────────────────────────────────────────

describe('listSubscriptions', () => {
    it('always filters by user_id (owner scoping)', async () => {
        const caller = callerId();
        subFindMock.mockReturnValueOnce(queryStub([]));
        subCountMock.mockResolvedValueOnce(0);

        await svc.listSubscriptions({ page: 1, limit: 20 }, caller);

        const filter = subFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.user_id).toBe(caller);
    });

    it('honours optional report_name + is_active filters', async () => {
        subFindMock.mockReturnValueOnce(queryStub([]));
        subCountMock.mockResolvedValueOnce(0);

        await svc.listSubscriptions({ report_name: 'leaves', is_active: false, page: 1, limit: 20 }, callerId());

        const filter = subFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.report_name).toBe('leaves');
        expect(filter.is_active).toBe(false);
    });
});

describe('getSubscription', () => {
    it('REPORT_SUBSCRIPTION_NOT_FOUND for unknown id (filter includes user_id)', async () => {
        const caller = callerId();
        subFindOneMock.mockResolvedValueOnce(null);

        await expect(svc.getSubscription(new Types.ObjectId(), caller)).rejects.toMatchObject({
            code: ERROR_CODES.REPORT_SUBSCRIPTION_NOT_FOUND,
        });
        const filter = subFindOneMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.user_id).toBe(caller);
    });
});

// ─── updateSubscription ────────────────────────────────────────────────

describe('updateSubscription', () => {
    it('updates fields without re-validating filters when filters not provided', async () => {
        const doc = makeSubDoc();
        subFindOneMock.mockResolvedValueOnce(doc);

        await svc.updateSubscription(
            doc._id as Types.ObjectId,
            { day_of_week: 5, is_active: false },
            callerId(),
            undefined
        );

        expect(doc.day_of_week).toBe(5);
        expect(doc.is_active).toBe(false);
        expect(doc.save).toHaveBeenCalledTimes(1);
    });

    it('validates filters against the LOCKED report_name on patch', async () => {
        // Existing sub is for billing. Operator tries to PATCH with leaves filter shape.
        const doc = makeSubDoc({ report_name: 'billing' });
        subFindOneMock.mockResolvedValueOnce(doc);

        await expect(
            svc.updateSubscription(
                doc._id as Types.ObjectId,
                { filters: { year: 2026 } }, // leaves shape
                callerId(),
                undefined
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    });

    it('REPORT_SUBSCRIPTION_NOT_FOUND on unknown id', async () => {
        subFindOneMock.mockResolvedValueOnce(null);
        await expect(
            svc.updateSubscription(new Types.ObjectId(), { name: 'x' }, callerId(), undefined)
        ).rejects.toMatchObject({ code: ERROR_CODES.REPORT_SUBSCRIPTION_NOT_FOUND });
    });
});

// ─── deleteSubscription ────────────────────────────────────────────────

describe('deleteSubscription', () => {
    it('deletes own subscription and audits the delete', async () => {
        const doc = makeSubDoc();
        subFindOneMock.mockResolvedValueOnce(doc);

        const result = await svc.deleteSubscription(doc._id as Types.ObjectId, callerId(), callerAudit());

        expect(result).toEqual({ deleted: true });
        expect(doc.deleteOne).toHaveBeenCalledTimes(1);
        const audit = recordAuditMock.mock.calls[0][1] as { action: string };
        expect(audit.action).toBe(AUDIT_ACTIONS.REPORT_SUBSCRIPTION_DELETE);
    });

    it('REPORT_SUBSCRIPTION_NOT_FOUND when row missing or cross-user', async () => {
        subFindOneMock.mockResolvedValueOnce(null);
        await expect(svc.deleteSubscription(new Types.ObjectId(), callerId(), undefined)).rejects.toMatchObject({
            code: ERROR_CODES.REPORT_SUBSCRIPTION_NOT_FOUND,
        });
    });
});

// ─── runWeeklyReportSweep ──────────────────────────────────────────────

describe('runWeeklyReportSweep', () => {
    const ownerActive = (overrides: Record<string, unknown> = {}) => ({
        _id: new Types.ObjectId(),
        full_name: 'Anna',
        email: 'anna@x',
        status: USER_STATUSES.ACTIVE,
        ...overrides,
    });

    it('happy path: sends email + stamps last_sent_at + audits send', async () => {
        const sub = makeSubDoc({ day_of_week: 1 }); // Monday
        subFindMock.mockReturnValueOnce(sweepStub([sub]));
        userFindByIdMock.mockReturnValueOnce(findByIdStub(ownerActive()));
        buildBillingMock.mockResolvedValueOnce(billingResultFixture());
        subFindOneAndUpdateMock.mockResolvedValueOnce({ _id: sub._id });

        // 2026-05-04 is a Monday (day=1 in IST).
        const summary = await svc.runWeeklyReportSweep(new Date('2026-05-04T07:00:00+05:30'));

        expect(summary.emails_sent).toBe(1);
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
        const audit = recordSystemAuditMock.mock.calls[0][0] as { action: string; metadata: { delivery: string } };
        expect(audit.action).toBe(AUDIT_ACTIONS.REPORT_SUBSCRIPTION_SEND);
        expect(audit.metadata.delivery).toBe('sent');
    });

    it('skips a subscription whose last_sent_at already equals today (idempotency)', async () => {
        const sub = makeSubDoc({ day_of_week: 1, last_sent_at: '2026-05-04' });
        subFindMock.mockReturnValueOnce(sweepStub([sub]));

        const summary = await svc.runWeeklyReportSweep(new Date('2026-05-04T07:00:00+05:30'));

        expect(summary.skipped_already_today).toBe(1);
        expect(summary.emails_sent).toBe(0);
        expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('skips subscriptions whose owner is deactivated (recipient gone)', async () => {
        const sub = makeSubDoc({ day_of_week: 1 });
        subFindMock.mockReturnValueOnce(sweepStub([sub]));
        userFindByIdMock.mockReturnValueOnce(findByIdStub(ownerActive({ status: USER_STATUSES.DEACTIVATED })));

        const summary = await svc.runWeeklyReportSweep(new Date('2026-05-04T07:00:00+05:30'));

        expect(summary.failures).toBe(1);
        expect(summary.emails_sent).toBe(0);
        expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('skips subscriptions whose owner has been hard-deleted (User.findById null)', async () => {
        const sub = makeSubDoc({ day_of_week: 1 });
        subFindMock.mockReturnValueOnce(sweepStub([sub]));
        userFindByIdMock.mockReturnValueOnce(findByIdStub(null));

        const summary = await svc.runWeeklyReportSweep(new Date('2026-05-04T07:00:00+05:30'));

        expect(summary.failures).toBe(1);
        expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('per-subscription failure does NOT abort the rest of the sweep', async () => {
        const failing = makeSubDoc({ day_of_week: 1 });
        const ok = makeSubDoc({ day_of_week: 1 });
        subFindMock.mockReturnValueOnce(sweepStub([failing, ok]));
        // First call: owner active, but report builder throws → failure.
        userFindByIdMock
            .mockReturnValueOnce(findByIdStub(ownerActive()))
            .mockReturnValueOnce(findByIdStub(ownerActive()));
        buildBillingMock.mockRejectedValueOnce(new Error('mongo blip')).mockResolvedValueOnce(billingResultFixture());
        subFindOneAndUpdateMock.mockResolvedValueOnce({ _id: ok._id });

        const summary = await svc.runWeeklyReportSweep(new Date('2026-05-04T07:00:00+05:30'));

        expect(summary.failures).toBe(1);
        expect(summary.emails_sent).toBe(1);
    });

    it('lost atomic stamp race produces a duplicate-warning failure (visible in summary)', async () => {
        const sub = makeSubDoc({ day_of_week: 1 });
        subFindMock.mockReturnValueOnce(sweepStub([sub]));
        userFindByIdMock.mockReturnValueOnce(findByIdStub(ownerActive()));
        buildBillingMock.mockResolvedValueOnce(billingResultFixture());
        // Stamp returns null → race lost.
        subFindOneAndUpdateMock.mockResolvedValueOnce(null);

        const summary = await svc.runWeeklyReportSweep(new Date('2026-05-04T07:00:00+05:30'));

        expect(summary.failures).toBe(1);
        expect(summary.emails_sent).toBe(0);
        // Email was sent BEFORE the stamp attempt — so the duplicate has already gone out.
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });

    it('race-loss path writes a `delivery: duplicate_sent` audit row (forensic trail)', async () => {
        const sub = makeSubDoc({ day_of_week: 1 });
        subFindMock.mockReturnValueOnce(sweepStub([sub]));
        userFindByIdMock.mockReturnValueOnce(findByIdStub(ownerActive()));
        buildBillingMock.mockResolvedValueOnce(billingResultFixture());
        subFindOneAndUpdateMock.mockResolvedValueOnce(null);

        await svc.runWeeklyReportSweep(new Date('2026-05-04T07:00:00+05:30'));

        // Without this audit, an admin investigating "why did this user
        // get two emails this morning" has no forensic trail showing
        // the race + duplicate happened.
        expect(recordSystemAuditMock).toHaveBeenCalledTimes(1);
        const audit = recordSystemAuditMock.mock.calls[0][0] as { metadata: { delivery: string } };
        expect(audit.metadata.delivery).toBe('duplicate_sent');
    });

    it('audits failures with delivery: failed for forensics', async () => {
        const sub = makeSubDoc({ day_of_week: 1 });
        subFindMock.mockReturnValueOnce(sweepStub([sub]));
        userFindByIdMock.mockReturnValueOnce(findByIdStub(ownerActive()));
        buildBillingMock.mockRejectedValueOnce(new Error('boom'));

        await svc.runWeeklyReportSweep(new Date('2026-05-04T07:00:00+05:30'));

        const audit = recordSystemAuditMock.mock.calls[0][0] as { metadata: { delivery: string } };
        expect(audit.metadata.delivery).toBe('failed');
    });
});

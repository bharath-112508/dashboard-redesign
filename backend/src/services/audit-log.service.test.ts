import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * Unit tests for `audit-log.service` (Step 31).
 *
 * Coverage focus:
 *   1. **Filter shape** — every query param maps to the right Mongo
 *      filter key and value type. Critical because the composite
 *      indexes live on `target_entity.kind` + `target_entity.id` (dotted
 *      paths) — using flat `target_kind` / `target_id` would silently
 *      skip the index and trigger a collection scan.
 *   2. **Date range** — `from_date` / `to_date` ISO strings convert to
 *      `Date` boundaries spanning the full local day in `DEFAULT_TIMEZONE`,
 *      so an admin filtering "2026-04-15" sees everything from that
 *      calendar day in IST regardless of UTC offset.
 *   3. **Snapshot stripping** — the list query runs `.select('-before -after')`
 *      so a 16-KiB snapshot doesn't get included on the list path.
 *   4. **Actor hydration** — the list batches `actor_id`s into ONE
 *      `User.find` call (no N+1) and stamps `{id, full_name}` per row.
 *   5. **Detail 404** — `getAuditLog(unknown_id)` returns `RESOURCE_NOT_FOUND`.
 */

const { auditFindMock, auditCountMock, auditFindByIdMock, userFindMock } = vi.hoisted(() => ({
    auditFindMock: vi.fn(),
    auditCountMock: vi.fn(),
    auditFindByIdMock: vi.fn(),
    userFindMock: vi.fn(),
}));

vi.mock('../models/audit-log.model.js', () => ({
    AuditLog: {
        find: auditFindMock,
        countDocuments: auditCountMock,
        findById: auditFindByIdMock,
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock },
}));

const svc = await import('./audit-log.service.js');

// ─── Helpers ─────────────────────────────────────────────────────────────

const queryStub = (rows: unknown[]) => {
    const stub: Record<string, unknown> = {
        select: () => stub,
        sort: () => stub,
        skip: () => stub,
        limit: () => stub,
        lean: () => Promise.resolve(rows),
        then: (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve),
    };
    return stub;
};

const makeRow = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    actor_id: new Types.ObjectId(),
    actor_role: 'admin',
    action: 'user.deactivate',
    target_entity: { kind: 'user', id: new Types.ObjectId() },
    before: null,
    after: null,
    metadata: {},
    created_at: new Date('2026-04-15T10:00:00Z'),
    ...overrides,
});

const baseQuery = (overrides: Record<string, unknown> = {}) => ({
    page: 1,
    limit: 20,
    ...overrides,
});

beforeEach(() => {
    vi.resetAllMocks();
    auditCountMock.mockResolvedValue(0);
    auditFindMock.mockReturnValue(queryStub([]));
    userFindMock.mockReturnValue(queryStub([]));
});

// ─── listAuditLogs filter shape ─────────────────────────────────────────

describe('listAuditLogs (filter shape)', () => {
    it('maps actor_id to an ObjectId Mongo filter', async () => {
        const actorId = new Types.ObjectId();
        await svc.listAuditLogs(baseQuery({ actor_id: actorId.toString() }) as never);
        const filter = auditFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.actor_id).toBeInstanceOf(Types.ObjectId);
        expect((filter.actor_id as Types.ObjectId).toString()).toBe(actorId.toString());
    });

    it('maps target_kind + target_id to dotted-path keys (composite index)', async () => {
        const targetId = new Types.ObjectId();
        await svc.listAuditLogs(baseQuery({ target_kind: 'user', target_id: targetId.toString() }) as never);
        const filter = auditFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter['target_entity.kind']).toBe('user');
        expect(filter['target_entity.id']).toBeInstanceOf(Types.ObjectId);
        // The flat shape would silently bypass the index — make sure we don't emit it.
        expect(filter.target_kind).toBeUndefined();
        expect(filter.target_id).toBeUndefined();
    });

    it('maps action to a string filter', async () => {
        await svc.listAuditLogs(baseQuery({ action: 'user.role_change' }) as never);
        const filter = auditFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.action).toBe('user.role_change');
    });

    it('builds an inclusive created_at range with day boundaries in DEFAULT_TIMEZONE', async () => {
        await svc.listAuditLogs(baseQuery({ from_date: '2026-04-15', to_date: '2026-04-15' }) as never);
        const filter = auditFindMock.mock.calls[0][0] as Record<string, unknown>;
        const range = filter.created_at as { $gte: Date; $lte: Date };
        expect(range.$gte).toBeInstanceOf(Date);
        expect(range.$lte).toBeInstanceOf(Date);
        // start-of-day IST = 18:30 UTC the previous day; end-of-day IST = 18:29:59.999 UTC.
        expect(range.$gte.toISOString()).toBe('2026-04-14T18:30:00.000Z');
        expect(range.$lte.toISOString()).toBe('2026-04-15T18:29:59.999Z');
    });

    it('omits the date filter entirely when both bounds are absent', async () => {
        await svc.listAuditLogs(baseQuery() as never);
        const filter = auditFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.created_at).toBeUndefined();
    });

    it('AND-combines multiple filters in a single query (no filter is silently dropped)', async () => {
        const actorId = new Types.ObjectId();
        const targetId = new Types.ObjectId();
        await svc.listAuditLogs(
            baseQuery({
                actor_id: actorId.toString(),
                action: 'user.deactivate',
                target_kind: 'user',
                target_id: targetId.toString(),
                from_date: '2026-04-01',
                to_date: '2026-04-30',
            }) as never
        );
        const filter = auditFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.actor_id).toBeInstanceOf(Types.ObjectId);
        expect(filter.action).toBe('user.deactivate');
        expect(filter['target_entity.kind']).toBe('user');
        expect(filter['target_entity.id']).toBeInstanceOf(Types.ObjectId);
        expect(filter.created_at).toEqual({
            $gte: new Date('2026-03-31T18:30:00.000Z'),
            $lte: new Date('2026-04-30T18:29:59.999Z'),
        });
    });

    it('builds a one-sided range when only from_date is provided', async () => {
        await svc.listAuditLogs(baseQuery({ from_date: '2026-04-15' }) as never);
        const filter = auditFindMock.mock.calls[0][0] as Record<string, unknown>;
        const range = filter.created_at as { $gte: Date; $lte?: Date };
        expect(range.$gte.toISOString()).toBe('2026-04-14T18:30:00.000Z');
        expect(range.$lte).toBeUndefined();
    });

    it('builds a one-sided range when only to_date is provided', async () => {
        await svc.listAuditLogs(baseQuery({ to_date: '2026-04-15' }) as never);
        const filter = auditFindMock.mock.calls[0][0] as Record<string, unknown>;
        const range = filter.created_at as { $gte?: Date; $lte: Date };
        expect(range.$lte.toISOString()).toBe('2026-04-15T18:29:59.999Z');
        expect(range.$gte).toBeUndefined();
    });

    it('sorts created_at desc with _id desc as the stable tiebreaker', async () => {
        const sortSpy = vi.fn().mockReturnThis();
        const stub: Record<string, unknown> = {
            select: () => stub,
            sort: sortSpy,
            skip: () => stub,
            limit: () => stub,
            then: (r: (v: unknown) => void) => Promise.resolve([]).then(r),
        };
        auditFindMock.mockReturnValueOnce(stub);
        await svc.listAuditLogs(baseQuery() as never);
        expect(sortSpy).toHaveBeenCalledWith({ created_at: -1, _id: -1 });
    });

    it('uses skip + limit for pagination math', async () => {
        const skipSpy = vi.fn().mockReturnThis();
        const limitSpy = vi.fn().mockReturnThis();
        const stub: Record<string, unknown> = {
            select: () => stub,
            sort: () => stub,
            skip: skipSpy,
            limit: limitSpy,
            then: (r: (v: unknown) => void) => Promise.resolve([]).then(r),
        };
        auditFindMock.mockReturnValueOnce(stub);
        await svc.listAuditLogs(baseQuery({ page: 3, limit: 25 }) as never);
        expect(skipSpy).toHaveBeenCalledWith(50); // (3-1) * 25
        expect(limitSpy).toHaveBeenCalledWith(25);
    });
});

// ─── Snapshot stripping + actor hydration ───────────────────────────────

describe('listAuditLogs (output shape)', () => {
    it('drops `before` / `after` from list rows via .select() exclusion', async () => {
        const selectSpy = vi.fn().mockReturnThis();
        const stub: Record<string, unknown> = {
            select: selectSpy,
            sort: () => stub,
            skip: () => stub,
            limit: () => stub,
            then: (r: (v: unknown) => void) => Promise.resolve([]).then(r),
        };
        auditFindMock.mockReturnValueOnce(stub);
        await svc.listAuditLogs(baseQuery() as never);
        expect(selectSpy).toHaveBeenCalledWith('-before -after');
    });

    it('hydrates actor_id with full_name in ONE batched User.find call', async () => {
        const actorA = new Types.ObjectId();
        const actorB = new Types.ObjectId();
        const rows = [makeRow({ actor_id: actorA }), makeRow({ actor_id: actorB }), makeRow({ actor_id: actorA })];
        auditFindMock.mockReturnValueOnce(queryStub(rows));
        auditCountMock.mockResolvedValueOnce(3);
        userFindMock.mockReturnValueOnce(
            queryStub([
                { _id: actorA, full_name: 'Anna' },
                { _id: actorB, full_name: 'Ben' },
            ])
        );

        const result = await svc.listAuditLogs(baseQuery() as never);

        // Single call, deduplicated id list (Anna appears twice in rows).
        expect(userFindMock).toHaveBeenCalledTimes(1);
        const userFilter = userFindMock.mock.calls[0][0] as { _id: { $in: Types.ObjectId[] } };
        expect(userFilter._id.$in).toHaveLength(2);

        expect(result.data[0].actor).toEqual({ id: actorA.toString(), full_name: 'Anna' });
        expect(result.data[1].actor).toEqual({ id: actorB.toString(), full_name: 'Ben' });
        expect(result.data[2].actor).toEqual({ id: actorA.toString(), full_name: 'Anna' });
    });

    it('renders actor as null for system rows (actor_id null)', async () => {
        const rows = [makeRow({ actor_id: null, actor_role: 'system', action: 'system.job_run' })];
        auditFindMock.mockReturnValueOnce(queryStub(rows));
        auditCountMock.mockResolvedValueOnce(1);

        const result = await svc.listAuditLogs(baseQuery() as never);

        expect(result.data[0].actor).toBeNull();
        expect(result.data[0].actor_role).toBe('system');
        // No User.find when there are no actors to hydrate.
        expect(userFindMock).not.toHaveBeenCalled();
    });

    it('preserves the actor id with full_name=null when the user has been hard-deleted', async () => {
        const ghostId = new Types.ObjectId();
        const rows = [makeRow({ actor_id: ghostId })];
        auditFindMock.mockReturnValueOnce(queryStub(rows));
        auditCountMock.mockResolvedValueOnce(1);
        userFindMock.mockReturnValueOnce(queryStub([])); // no matching user

        const result = await svc.listAuditLogs(baseQuery() as never);

        expect(result.data[0].actor).toEqual({ id: ghostId.toString(), full_name: null });
    });

    it('returns the meta envelope with computed total_pages', async () => {
        auditFindMock.mockReturnValueOnce(queryStub([]));
        auditCountMock.mockResolvedValueOnce(47);
        const result = await svc.listAuditLogs(baseQuery({ page: 1, limit: 20 }) as never);
        expect(result.meta).toEqual({ page: 1, limit: 20, total: 47, total_pages: 3 });
    });
});

// ─── getAuditLog ────────────────────────────────────────────────────────

describe('getAuditLog', () => {
    it('returns the full row including before/after on success', async () => {
        const row = makeRow({
            before: { role: 'employee' },
            after: { role: 'manager' },
            metadata: { changed_by_admin_id: 'x' },
        });
        auditFindByIdMock.mockResolvedValueOnce(row);
        userFindMock.mockReturnValueOnce(queryStub([{ _id: row.actor_id, full_name: 'Anna' }]));

        const result = await svc.getAuditLog(row._id);

        expect(result.id).toBe(row._id.toString());
        expect(result.before).toEqual({ role: 'employee' });
        expect(result.after).toEqual({ role: 'manager' });
        expect(result.actor).toEqual({ id: (row.actor_id as Types.ObjectId).toString(), full_name: 'Anna' });
    });

    it('throws RESOURCE_NOT_FOUND when the id is unknown', async () => {
        auditFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.getAuditLog(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
        });
    });

    it('skips the User.find lookup entirely for a system row (actor_id null)', async () => {
        const row = makeRow({ actor_id: null, actor_role: 'system', action: 'system.job_run' });
        auditFindByIdMock.mockResolvedValueOnce(row);

        const result = await svc.getAuditLog(row._id);

        expect(result.actor).toBeNull();
        expect(userFindMock).not.toHaveBeenCalled();
    });
});

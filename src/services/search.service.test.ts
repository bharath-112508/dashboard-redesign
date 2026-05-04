import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';

/**
 * Unit tests for `search.service` (Step 32).
 *
 * Coverage focus:
 *   1. **Regex injection guard** — every metacharacter in the user
 *      query is escaped before being passed to Mongo. A literal
 *      `q = ".*"` must NOT match every row.
 *   2. **Role-visibility scoping** — admins/managers see all rows;
 *      employees scope to their projects; clients scope to their
 *      projects AND see no users.
 *   3. **Types filter** — when only one bucket is requested, the
 *      others run zero DB queries (no wasted roundtrips).
 *   4. **Empty visible-projects short-circuit** — clients/employees
 *      with no project membership get empty sprint + task buckets
 *      WITHOUT a follow-up DB call.
 *   5. **Per-bucket cap** — the `.limit()` call uses the validated
 *      query limit verbatim.
 */

const { userFindMock, projectFindMock, sprintFindMock, taskFindMock, buildProjectVisibilityFilterMock } = vi.hoisted(
    () => ({
        userFindMock: vi.fn(),
        projectFindMock: vi.fn(),
        sprintFindMock: vi.fn(),
        taskFindMock: vi.fn(),
        buildProjectVisibilityFilterMock: vi.fn(),
    })
);

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { find: projectFindMock },
}));

vi.mock('../models/sprint.model.js', () => ({
    Sprint: { find: sprintFindMock },
}));

vi.mock('../models/task.model.js', () => ({
    Task: { find: taskFindMock },
}));

vi.mock('./project.service.js', () => ({
    buildProjectVisibilityFilter: buildProjectVisibilityFilterMock,
}));

const svc = await import('./search.service.js');

// ─── Helpers ─────────────────────────────────────────────────────────────

const queryStub = (rows: unknown[]) => {
    const stub: Record<string, unknown> = {
        select: () => stub,
        limit: () => stub,
        lean: () => Promise.resolve(rows),
        then: (r: (v: unknown) => void) => Promise.resolve(rows).then(r),
    };
    return stub;
};

const adminCaller = () => ({ id: new Types.ObjectId(), role: ROLES.ADMIN });
const employeeCaller = () => ({ id: new Types.ObjectId(), role: ROLES.EMPLOYEE });
const clientCaller = () => ({ id: new Types.ObjectId(), role: ROLES.CLIENT });

const baseQuery = (overrides: Record<string, unknown> = {}) => ({
    q: 'login',
    limit: 10,
    ...overrides,
});

beforeEach(() => {
    vi.resetAllMocks();
    userFindMock.mockReturnValue(queryStub([]));
    projectFindMock.mockReturnValue(queryStub([]));
    sprintFindMock.mockReturnValue(queryStub([]));
    taskFindMock.mockReturnValue(queryStub([]));
    buildProjectVisibilityFilterMock.mockReturnValue({});
});

// ─── Regex escape ───────────────────────────────────────────────────────

describe('regex escape', () => {
    it('escapes regex metacharacters so a literal query stays literal', () => {
        // ".*" should match the literal three-character string ".*", not "anything".
        const re = new RegExp(svc.__escapeRegex('.*'), 'i');
        expect(re.test('foo')).toBe(false);
        expect(re.test('hello.*world')).toBe(true);
    });

    it('escapes a query that would otherwise be invalid regex syntax', () => {
        // Bare "?" is a regex syntax error; the escape turns it into a literal.
        expect(() => new RegExp(svc.__escapeRegex('?'), 'i')).not.toThrow();
        const re = new RegExp(svc.__escapeRegex('('), 'i');
        expect(re.test('hello (world)')).toBe(true);
    });
});

// ─── Admin / manager (no extra visibility filter) ───────────────────────

describe('search (admin / manager)', () => {
    it('returns all four buckets without a per-project visibility prefilter', async () => {
        userFindMock.mockReturnValueOnce(
            queryStub([{ _id: new Types.ObjectId(), full_name: 'Anna Login', role: 'employee' }])
        );
        projectFindMock.mockReturnValueOnce(queryStub([{ _id: new Types.ObjectId(), name: 'Login Page', code: 'LP' }]));
        sprintFindMock.mockReturnValueOnce(
            queryStub([{ _id: new Types.ObjectId(), name: 'Sprint Login', project_id: new Types.ObjectId() }])
        );
        taskFindMock.mockReturnValueOnce(
            queryStub([{ _id: new Types.ObjectId(), title: 'Fix login bug', project_id: new Types.ObjectId() }])
        );

        const result = await svc.search(baseQuery() as never, adminCaller());

        expect(result.users).toHaveLength(1);
        expect(result.projects).toHaveLength(1);
        expect(result.sprints).toHaveLength(1);
        expect(result.tasks).toHaveLength(1);
        // Admins skip the resolveVisibleProjectIds prefilter — projectFind
        // is called once (for the projects bucket) and sprint/task filters
        // do NOT carry a project_id constraint.
        expect(projectFindMock).toHaveBeenCalledTimes(1);
        const sprintFilter = sprintFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(sprintFilter.project_id).toBeUndefined();
        const taskFilter = taskFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(taskFilter.project_id).toBeUndefined();
    });

    it('filters users to status=active', async () => {
        await svc.search(baseQuery() as never, adminCaller());
        const filter = userFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.status).toBe(USER_STATUSES.ACTIVE);
    });

    it('filters projects to is_archived=false', async () => {
        await svc.search(baseQuery() as never, adminCaller());
        const filter = projectFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.is_archived).toBe(false);
    });

    it('searches users by full_name only — email is NOT a search field (PII contract)', async () => {
        await svc.search(baseQuery({ q: 'login' }) as never, adminCaller());
        const filter = userFindMock.mock.calls[0][0] as Record<string, unknown>;
        // No $or fan-out into email — full_name is the only key we match against.
        expect(filter.$or).toBeUndefined();
        expect(filter.full_name).toBeInstanceOf(RegExp);
        expect(filter.email).toBeUndefined();
    });

    it('does not include `email` in user hits (matches API_Contract §13 shape; admin-only via /users?q=)', async () => {
        userFindMock.mockReturnValueOnce(
            queryStub([{ _id: new Types.ObjectId(), full_name: 'Anna', email: 'leak@x', role: 'employee' }])
        );
        const result = await svc.search(baseQuery() as never, adminCaller());
        expect(result.users[0]).toEqual({
            id: expect.any(String),
            full_name: 'Anna',
            role: 'employee',
        });
        // Even if the row from Mongo has email, the projection drops it
        // and the response shape doesn't carry it.
        expect((result.users[0] as unknown as Record<string, unknown>).email).toBeUndefined();
    });

    it('does not include `status` in project hits (matches API_Contract §13 shape)', async () => {
        projectFindMock.mockReturnValueOnce(
            queryStub([{ _id: new Types.ObjectId(), name: 'Login Page', code: 'LP', status: 'active' }])
        );
        const result = await svc.search(baseQuery({ types: ['projects'] }) as never, adminCaller());
        expect(result.projects[0]).toEqual({
            id: expect.any(String),
            name: 'Login Page',
            code: 'LP',
        });
        expect((result.projects[0] as unknown as Record<string, unknown>).status).toBeUndefined();
    });
});

// ─── Employee scoping ───────────────────────────────────────────────────

describe('search (employee)', () => {
    it('uses buildProjectVisibilityFilter for the project bucket and prefilters sprints/tasks by visible_ids', async () => {
        const employee = employeeCaller();
        const visibleId = new Types.ObjectId();
        buildProjectVisibilityFilterMock.mockReturnValue({ member_ids: employee.id });
        // First Project.find — the visible-id resolver. Second one — the projects bucket.
        projectFindMock
            .mockReturnValueOnce(queryStub([{ _id: visibleId }])) // resolveVisibleProjectIds
            .mockReturnValueOnce(queryStub([])); // projects bucket

        await svc.search(baseQuery() as never, employee);

        // Project visibility filter was consulted.
        expect(buildProjectVisibilityFilterMock).toHaveBeenCalled();

        // Sprint + task queries carry the visible-project prefilter.
        const sprintFilter = sprintFindMock.mock.calls[0][0] as { project_id: { $in: Types.ObjectId[] } };
        expect(sprintFilter.project_id.$in.map((i) => i.toString())).toEqual([visibleId.toString()]);
        const taskFilter = taskFindMock.mock.calls[0][0] as { project_id: { $in: Types.ObjectId[] } };
        expect(taskFilter.project_id.$in.map((i) => i.toString())).toEqual([visibleId.toString()]);
    });

    it('still surfaces the user directory (employees can find colleagues)', async () => {
        await svc.search(baseQuery() as never, employeeCaller());
        expect(userFindMock).toHaveBeenCalledTimes(1);
    });

    it('short-circuits sprint + task buckets when the caller has zero visible projects', async () => {
        projectFindMock.mockReturnValueOnce(queryStub([])); // resolveVisibleProjectIds returns empty
        await svc.search(baseQuery({ types: ['sprints', 'tasks'] }) as never, employeeCaller());
        // No DB call for sprints / tasks because we short-circuit on an empty visible-id list.
        expect(sprintFindMock).not.toHaveBeenCalled();
        expect(taskFindMock).not.toHaveBeenCalled();
    });

    it('skips resolveVisibleProjectIds when only users/projects are requested (saves one roundtrip)', async () => {
        // For an employee searching only `users`, the visible-project
        // resolver isn't needed — neither the user bucket nor any
        // skipped sprint/task bucket consumes it. Project.find should
        // NOT fire from the resolver.
        await svc.search(baseQuery({ types: ['users'] }) as never, employeeCaller());
        expect(projectFindMock).not.toHaveBeenCalled();

        projectFindMock.mockClear();
        // Searching only `projects` also doesn't need the resolver — the
        // projects bucket builds its own visibility filter via
        // `buildProjectVisibilityFilter`. So Project.find fires ONCE
        // (the bucket query), not twice.
        await svc.search(baseQuery({ types: ['projects'] }) as never, employeeCaller());
        expect(projectFindMock).toHaveBeenCalledTimes(1);
    });
});

// ─── Client scoping ─────────────────────────────────────────────────────

describe('search (client)', () => {
    it('returns an empty users[] without hitting the User collection (HR is internal-only)', async () => {
        const client = clientCaller();
        projectFindMock.mockReturnValueOnce(queryStub([])); // resolveVisibleProjectIds

        const result = await svc.search(baseQuery() as never, client);

        expect(result.users).toEqual([]);
        expect(userFindMock).not.toHaveBeenCalled();
    });

    it('still searches projects/sprints/tasks scoped to client_ids', async () => {
        const client = clientCaller();
        const visibleId = new Types.ObjectId();
        buildProjectVisibilityFilterMock.mockReturnValue({ client_ids: client.id });
        projectFindMock
            .mockReturnValueOnce(queryStub([{ _id: visibleId }])) // resolveVisibleProjectIds
            .mockReturnValueOnce(queryStub([])); // projects bucket

        await svc.search(baseQuery() as never, client);

        const projectsBucketFilter = projectFindMock.mock.calls[1][0] as Record<string, unknown>;
        expect(projectsBucketFilter.client_ids).toEqual(client.id);
    });
});

// ─── types= filtering ───────────────────────────────────────────────────

describe('search (types= filter)', () => {
    it('skips the DB call for buckets the caller did not request', async () => {
        await svc.search(baseQuery({ types: ['users'] }) as never, adminCaller());
        expect(userFindMock).toHaveBeenCalledTimes(1);
        expect(projectFindMock).not.toHaveBeenCalled();
        expect(sprintFindMock).not.toHaveBeenCalled();
        expect(taskFindMock).not.toHaveBeenCalled();
    });

    it('returns deterministic empty arrays for buckets the caller did not request', async () => {
        const result = await svc.search(baseQuery({ types: ['users'] }) as never, adminCaller());
        expect(result.projects).toEqual([]);
        expect(result.sprints).toEqual([]);
        expect(result.tasks).toEqual([]);
    });

    it('with no `types`, searches all four buckets (default behaviour)', async () => {
        await svc.search(baseQuery() as never, adminCaller());
        expect(userFindMock).toHaveBeenCalledTimes(1);
        expect(projectFindMock).toHaveBeenCalledTimes(1);
        expect(sprintFindMock).toHaveBeenCalledTimes(1);
        expect(taskFindMock).toHaveBeenCalledTimes(1);
    });
});

// ─── Per-bucket cap ─────────────────────────────────────────────────────

describe('search (limit)', () => {
    it('passes the validated limit to .limit() on every bucket', async () => {
        const limitSpy = vi.fn().mockReturnThis();
        const stub: Record<string, unknown> = {
            select: () => stub,
            limit: limitSpy,
            lean: () => Promise.resolve([]),
            then: (r: (v: unknown) => void) => Promise.resolve([]).then(r),
        };
        userFindMock.mockReturnValue(stub);
        projectFindMock.mockReturnValue(stub);
        sprintFindMock.mockReturnValue(stub);
        taskFindMock.mockReturnValue(stub);

        await svc.search(baseQuery({ limit: 25 }) as never, adminCaller());
        // Each bucket calls .limit(25). For employees the resolveVisibleProjectIds
        // also runs (no .limit) — but we're admin here so just 4 bucket calls.
        const limitCalls = limitSpy.mock.calls.filter(([n]) => n === 25);
        expect(limitCalls).toHaveLength(4);
    });
});

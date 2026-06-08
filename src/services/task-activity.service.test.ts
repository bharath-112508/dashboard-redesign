import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `task-activity.service` (Step 20).
 *
 * Coverage focus:
 *   1. `recordActivity` — happy path persists with defaulted nulls;
 *      DB failures are swallowed (best-effort contract).
 *   2. `recordActivityIfChanged` — equality short-circuits for primitives,
 *      ObjectIds (via `.equals`), and null-vs-null; persists on real diffs.
 *   3. `listActivities` — task 404, project-visibility 403 propagation,
 *      filter composition with `activity_type` + `actor_id`, default
 *      sort + pagination.
 */

const {
    activityCreateMock,
    activityFindMock,
    activityCountDocumentsMock,
    taskFindByIdMock,
    userFindMock,
    loadProjectForCallerMock,
    loggerWarnMock,
} = vi.hoisted(() => ({
    activityCreateMock: vi.fn(),
    activityFindMock: vi.fn(),
    activityCountDocumentsMock: vi.fn(),
    taskFindByIdMock: vi.fn(),
    userFindMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    loggerWarnMock: vi.fn(),
}));

vi.mock('../models/task-activity.model.js', () => ({
    TaskActivity: {
        create: activityCreateMock,
        find: activityFindMock,
        countDocuments: activityCountDocumentsMock,
    },
}));

vi.mock('../models/task.model.js', () => ({
    Task: { findById: taskFindByIdMock },
}));

// M38 — activity rows ship hydrated `actor` displays. The list path
// calls `User.find({_id: {$in: [...]}}).select(...).lean()` once per
// page; stub the chain.
vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock },
}));

vi.mock('./project.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./project.service.js')>();
    return { ...actual, loadProjectForCaller: loadProjectForCallerMock };
});

vi.mock('../utils/logger.js', () => ({
    default: { warn: loggerWarnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const svc = await import('./task-activity.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { TASK_ACTIVITY_TYPES } from '../constants/task-activity.js';

const adminCaller = () => ({ id: new Types.ObjectId(), role: ROLES.ADMIN, audit: undefined });
const employeeCaller = () => ({ id: new Types.ObjectId(), role: ROLES.EMPLOYEE, audit: undefined });

const stubTaskLookup = (row: { _id: Types.ObjectId; project_id: Types.ObjectId } | null): void => {
    taskFindByIdMock.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(row) }),
    });
};

const stubFindForList = (rows: Array<{ toJSON: () => Record<string, unknown> }>, total = rows.length): void => {
    activityFindMock.mockReturnValueOnce({
        sort: () => ({
            skip: () => ({
                limit: () => Promise.resolve(rows),
            }),
        }),
    });
    activityCountDocumentsMock.mockResolvedValueOnce(total);
};

beforeEach(() => {
    vi.resetAllMocks();
    // M38 — default actor-display hydration returns []; tests that
    // care about the hydrated `actor` field override this.
    userFindMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve([]) }),
    });
});

// ─── recordActivity ──────────────────────────────────────────────────────

describe('recordActivity', () => {
    it('persists with defaulted null from/to and empty metadata', async () => {
        activityCreateMock.mockResolvedValueOnce({});
        const taskId = new Types.ObjectId();
        const actorId = new Types.ObjectId();

        await svc.recordActivity({
            task_id: taskId,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.CREATED,
        });

        expect(activityCreateMock).toHaveBeenCalledWith({
            task_id: taskId,
            actor_id: actorId,
            activity_type: 'created',
            from_value: null,
            to_value: null,
            metadata: {},
        });
    });

    it('forwards explicit from/to/metadata payloads unchanged', async () => {
        activityCreateMock.mockResolvedValueOnce({});
        const taskId = new Types.ObjectId();
        const actorId = new Types.ObjectId();
        const meta = { comment_id: 'abc' };

        await svc.recordActivity({
            task_id: taskId,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.STATUS_CHANGED,
            from_value: 'todo',
            to_value: 'done',
            metadata: meta,
        });

        expect(activityCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                from_value: 'todo',
                to_value: 'done',
                metadata: meta,
            })
        );
    });

    it('swallows DB failures and logs at warn with the canonical code', async () => {
        activityCreateMock.mockRejectedValueOnce(new Error('mongo down'));

        await expect(
            svc.recordActivity({
                task_id: new Types.ObjectId(),
                actor_id: new Types.ObjectId(),
                activity_type: TASK_ACTIVITY_TYPES.CREATED,
            })
        ).resolves.toBeUndefined();

        expect(loggerWarnMock).toHaveBeenCalledTimes(1);
        const logArg = loggerWarnMock.mock.calls[0][0] as { code: string };
        expect(logArg.code).toBe('ACTIVITY_WRITE_FAILED');
    });
});

// ─── recordActivityIfChanged ─────────────────────────────────────────────

describe('recordActivityIfChanged', () => {
    it('skips when both values are equal primitives', async () => {
        const wrote = await svc.recordActivityIfChanged({
            task_id: new Types.ObjectId(),
            actor_id: new Types.ObjectId(),
            activity_type: TASK_ACTIVITY_TYPES.STATUS_CHANGED,
            from_value: 'todo',
            to_value: 'todo',
        });
        expect(wrote).toBe(false);
        expect(activityCreateMock).not.toHaveBeenCalled();
    });

    it('skips when both values are equal ObjectIds (via .equals)', async () => {
        const id = new Types.ObjectId();
        const wrote = await svc.recordActivityIfChanged({
            task_id: new Types.ObjectId(),
            actor_id: new Types.ObjectId(),
            activity_type: TASK_ACTIVITY_TYPES.ASSIGNEE_CHANGED,
            from_value: id,
            // Different reference, same id — must compare equal.
            to_value: new Types.ObjectId(id.toString()),
        });
        expect(wrote).toBe(false);
        expect(activityCreateMock).not.toHaveBeenCalled();
    });

    it('skips when both values are nullish', async () => {
        const wrote = await svc.recordActivityIfChanged({
            task_id: new Types.ObjectId(),
            actor_id: new Types.ObjectId(),
            activity_type: TASK_ACTIVITY_TYPES.STORY_CHANGED,
            from_value: null,
            to_value: undefined,
        });
        expect(wrote).toBe(false);
        expect(activityCreateMock).not.toHaveBeenCalled();
    });

    it('persists on a real change', async () => {
        activityCreateMock.mockResolvedValueOnce({});
        const wrote = await svc.recordActivityIfChanged({
            task_id: new Types.ObjectId(),
            actor_id: new Types.ObjectId(),
            activity_type: TASK_ACTIVITY_TYPES.STATUS_CHANGED,
            from_value: 'todo',
            to_value: 'done',
        });
        expect(wrote).toBe(true);
        expect(activityCreateMock).toHaveBeenCalledTimes(1);
    });
});

// ─── listActivities ──────────────────────────────────────────────────────

describe('listActivities', () => {
    it('returns 404 when the parent task is missing', async () => {
        stubTaskLookup(null);
        await expect(
            svc.listActivities(new Types.ObjectId(), { page: 1, limit: 20, include_subtasks: false }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_NOT_FOUND });
        expect(loadProjectForCallerMock).not.toHaveBeenCalled();
    });

    it('propagates project-visibility 403 from loadProjectForCaller unchanged', async () => {
        const projectId = new Types.ObjectId();
        const taskId = new Types.ObjectId();
        stubTaskLookup({ _id: taskId, project_id: projectId });
        loadProjectForCallerMock.mockRejectedValueOnce(
            Object.assign(new Error('Forbidden'), { code: ERROR_CODES.FORBIDDEN, statusCode: 403 })
        );

        await expect(
            svc.listActivities(taskId, { page: 1, limit: 20, include_subtasks: false }, employeeCaller())
        ).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
        expect(activityFindMock).not.toHaveBeenCalled();
    });

    it('composes filter with activity_type + actor_id and returns paginated rows', async () => {
        const projectId = new Types.ObjectId();
        const taskId = new Types.ObjectId();
        const actorId = new Types.ObjectId();
        stubTaskLookup({ _id: taskId, project_id: projectId });
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: projectId, member_ids: [], client_ids: [] });
        // M38 — actor_id is now read off the doc (not its toJSON shape)
        // so the per-page hydration can batch-load `{id, full_name}`.
        // Stub matches that contract.
        const row = {
            actor_id: actorId,
            toJSON: () => ({ id: 'act1', activity_type: 'status_changed', actor_id: actorId.toString() }),
        };
        stubFindForList([row], 5);

        const result = await svc.listActivities(
            taskId,
            {
                page: 1,
                limit: 20,
                include_subtasks: false,
                activity_type: TASK_ACTIVITY_TYPES.STATUS_CHANGED,
                actor_id: actorId.toString(),
            },
            adminCaller()
        );

        const filterArg = activityFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg).toMatchObject({
            task_id: taskId,
            activity_type: 'status_changed',
        });
        // actor_id round-trips as ObjectId (compared by .equals)
        expect((filterArg.actor_id as Types.ObjectId).equals(actorId)).toBe(true);
        expect(result.data).toHaveLength(1);
        expect(result.meta).toEqual({ page: 1, limit: 20, total: 5, total_pages: 1 });
    });

    it('omits optional filters when not provided', async () => {
        const projectId = new Types.ObjectId();
        const taskId = new Types.ObjectId();
        stubTaskLookup({ _id: taskId, project_id: projectId });
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: projectId, member_ids: [], client_ids: [] });
        stubFindForList([], 0);

        await svc.listActivities(taskId, { page: 2, limit: 10, include_subtasks: false }, adminCaller());

        const filterArg = activityFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg).toEqual({ task_id: taskId });
    });
});

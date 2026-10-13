import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS } from '../constants/audit.js';

/**
 * Unit tests for `task-template.service` (Phase 4 Step 40).
 *
 * Coverage focus:
 *   1. **createTemplate** — admin/manager guard; reads project for
 *      visibility; emits TASK_TEMPLATE_CREATE audit.
 *   2. **instantiateTemplate** — manual path delegates to task.service
 *      with overrides + reference re-validation; archived templates
 *      reject with `TASK_TEMPLATE_NOT_FOUND` (avoids enumeration via
 *      a different error code).
 *   3. **Reference resilience** — stale assignee / collaborators /
 *      story / sprint silently dropped at instantiation time.
 *   4. **runRecurringTaskSweep** — schedule semantics (daily / weekly /
 *      monthly); window check (start_date / end_date); idempotency via
 *      `recurrence.last_generated_at`; race-loss on stamp atomic
 *      update; per-template failure isolation.
 */

const {
    templateCreateMock,
    templateFindByIdMock,
    templateFindOneAndUpdateMock,
    templateFindMock,
    userFindMock,
    storyFindOneMock,
    sprintFindOneMock,
    loadProjectForCallerMock,
    createTaskMock,
    recordAuditMock,
    recordSystemAuditMock,
} = vi.hoisted(() => ({
    templateCreateMock: vi.fn(),
    templateFindByIdMock: vi.fn(),
    templateFindOneAndUpdateMock: vi.fn(),
    templateFindMock: vi.fn(),
    userFindMock: vi.fn(),
    storyFindOneMock: vi.fn(),
    sprintFindOneMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    createTaskMock: vi.fn(),
    recordAuditMock: vi.fn(),
    recordSystemAuditMock: vi.fn(),
}));

vi.mock('../models/task-template.model.js', () => ({
    TaskTemplate: {
        create: templateCreateMock,
        findById: templateFindByIdMock,
        findOneAndUpdate: templateFindOneAndUpdateMock,
        find: templateFindMock,
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock },
}));

vi.mock('../models/story.model.js', () => ({
    Story: { findOne: storyFindOneMock },
}));

vi.mock('../models/sprint.model.js', () => ({
    Sprint: { findOne: sprintFindOneMock },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { findOne: vi.fn(), findById: vi.fn() },
}));

vi.mock('./project.service.js', () => ({
    loadProjectForCaller: loadProjectForCallerMock,
}));

vi.mock('./task.service.js', () => ({
    createTask: createTaskMock,
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: recordSystemAuditMock,
}));

const svc = await import('./task-template.service.js');

// ─── Helpers ────────────────────────────────────────────────────────────

const adminCaller = () => ({
    id: new Types.ObjectId(),
    role: ROLES.ADMIN,
    audit: {
        actor_id: new Types.ObjectId(),
        actor_role: 'admin' as const,
        ip: null,
        user_agent: null,
        request_id: null,
    },
});

const employeeCaller = () => ({
    id: new Types.ObjectId(),
    role: ROLES.EMPLOYEE,
});

const queryStub = (rows: unknown[]) => {
    const stub: Record<string, unknown> = {
        select: () => stub,
        sort: () => stub,
        skip: () => stub,
        limit: () => stub,
        lean: () => Promise.resolve(rows),
        then: (r: (v: unknown) => void) => Promise.resolve(rows).then(r),
    };
    return stub;
};

const findOneStub = (row: unknown) => ({
    select: () => findOneStub(row),
    lean: () => Promise.resolve(row),
});

const baseBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Weekly status update',
    title: 'Status update',
    description: '',
    priority: 'medium' as const,
    default_assignee_id: null,
    default_collaborator_ids: [],
    default_story_id: null,
    default_sprint_id: null,
    default_due_offset_days: null,
    default_estimated_hours: 0,
    recurrence: null,
    ...overrides,
});

const makeTemplate = (overrides: Record<string, unknown> = {}) => {
    const _id = new Types.ObjectId();
    const tpl = {
        _id,
        project_id: new Types.ObjectId(),
        name: 'Tpl',
        title: 'Title',
        description: '',
        priority: 'medium',
        default_assignee_id: null,
        default_collaborator_ids: [],
        default_story_id: null,
        default_sprint_id: null,
        default_due_offset_days: null,
        default_estimated_hours: 0,
        recurrence: null,
        is_archived: false,
        created_by: new Types.ObjectId(),
        toJSON: vi.fn(),
        ...overrides,
    };
    tpl.toJSON.mockImplementation(() => ({ id: _id.toString(), ...tpl }));
    return tpl;
};

beforeEach(() => {
    vi.resetAllMocks();
    loadProjectForCallerMock.mockResolvedValue({ _id: new Types.ObjectId(), member_ids: [], representative_ids: [] });
    recordAuditMock.mockResolvedValue(undefined);
    recordSystemAuditMock.mockResolvedValue(undefined);
});

// ─── createTemplate ────────────────────────────────────────────────────

describe('createTemplate', () => {
    it('rejects employees with FORBIDDEN', async () => {
        await expect(
            svc.createTemplate(new Types.ObjectId(), baseBody() as never, employeeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
        expect(templateCreateMock).not.toHaveBeenCalled();
    });

    it('admin path creates the template + emits TASK_TEMPLATE_CREATE audit', async () => {
        const tpl = makeTemplate();
        templateCreateMock.mockResolvedValueOnce(tpl);

        const result = await svc.createTemplate(new Types.ObjectId(), baseBody() as never, adminCaller());

        expect(templateCreateMock).toHaveBeenCalledTimes(1);
        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const audit = recordAuditMock.mock.calls[0][1] as { action: string };
        expect(audit.action).toBe(AUDIT_ACTIONS.TASK_TEMPLATE_CREATE);
        expect(result).toBeDefined();
    });
});

// ─── instantiateTemplate ───────────────────────────────────────────────

describe('instantiateTemplate', () => {
    it('rejects archived templates with TASK_TEMPLATE_NOT_FOUND (anti-enumeration)', async () => {
        const tpl = makeTemplate({ is_archived: true });
        templateFindByIdMock.mockResolvedValueOnce(tpl);

        await expect(svc.instantiateTemplate(tpl._id, {}, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_TEMPLATE_NOT_FOUND,
        });
    });

    it('happy path delegates to createTask with template defaults + audit row', async () => {
        const projectId = new Types.ObjectId();
        const tpl = makeTemplate({ project_id: projectId, title: 'Status update', priority: 'high' });
        templateFindByIdMock.mockResolvedValueOnce(tpl);
        // No user / story / sprint refs to validate.
        userFindMock.mockReturnValue(queryStub([]));
        createTaskMock.mockResolvedValueOnce({ id: 'new-task-id' });

        const result = await svc.instantiateTemplate(tpl._id, {}, adminCaller());

        expect(createTaskMock).toHaveBeenCalledTimes(1);
        const taskBody = createTaskMock.mock.calls[0][0] as Record<string, unknown>;
        expect(taskBody.project_id).toBe(projectId.toString());
        expect(taskBody.title).toBe('Status update');
        expect(taskBody.priority).toBe('high');
        expect(result).toEqual({ id: 'new-task-id' });

        const audit = recordAuditMock.mock.calls[0][1] as { action: string; metadata: { source: string } };
        expect(audit.action).toBe(AUDIT_ACTIONS.TASK_TEMPLATE_INSTANTIATE);
        expect(audit.metadata.source).toBe('manual');
    });

    it('overrides win over template defaults', async () => {
        const projectId = new Types.ObjectId();
        const tpl = makeTemplate({ project_id: projectId, title: 'Default title', priority: 'low' });
        templateFindByIdMock.mockResolvedValueOnce(tpl);
        userFindMock.mockReturnValue(queryStub([]));
        createTaskMock.mockResolvedValueOnce({ id: 'new-task-id' });

        await svc.instantiateTemplate(tpl._id, { title: 'One-off override', due_date: '2026-12-01' }, adminCaller());

        const taskBody = createTaskMock.mock.calls[0][0] as Record<string, unknown>;
        expect(taskBody.title).toBe('One-off override');
        expect(taskBody.due_date).toBe('2026-12-01');
    });

    it('drops a stale primary_assignee_id reference and logs warn', async () => {
        const staleAssignee = new Types.ObjectId();
        const tpl = makeTemplate({ default_assignee_id: staleAssignee });
        templateFindByIdMock.mockResolvedValueOnce(tpl);
        // User.find returns empty → stale id filtered out.
        userFindMock.mockReturnValueOnce(queryStub([]));
        createTaskMock.mockResolvedValueOnce({ id: 'new-task-id' });

        await svc.instantiateTemplate(tpl._id, {}, adminCaller());

        const taskBody = createTaskMock.mock.calls[0][0] as Record<string, unknown>;
        expect(taskBody.primary_assignee_id).toBeNull();
    });

    it('keeps the still-active subset of collaborator_ids and drops the rest', async () => {
        const active = new Types.ObjectId();
        const stale = new Types.ObjectId();
        const tpl = makeTemplate({ default_collaborator_ids: [active, stale] });
        templateFindByIdMock.mockResolvedValueOnce(tpl);
        // User.find returns only the active id.
        userFindMock.mockReturnValueOnce(queryStub([{ _id: active }]));
        createTaskMock.mockResolvedValueOnce({ id: 'new-task-id' });

        await svc.instantiateTemplate(tpl._id, {}, adminCaller());

        const taskBody = createTaskMock.mock.calls[0][0] as { collaborator_ids: string[] };
        expect(taskBody.collaborator_ids).toEqual([active.toString()]);
    });

    it('drops a stale story_id reference (story for a different project)', async () => {
        const staleStory = new Types.ObjectId();
        const tpl = makeTemplate({ default_story_id: staleStory });
        templateFindByIdMock.mockResolvedValueOnce(tpl);
        userFindMock.mockReturnValue(queryStub([]));
        // Story.findOne returns null for the (story_id, project_id) pair.
        storyFindOneMock.mockReturnValueOnce(findOneStub(null));
        createTaskMock.mockResolvedValueOnce({ id: 'new-task-id' });

        await svc.instantiateTemplate(tpl._id, {}, adminCaller());

        const taskBody = createTaskMock.mock.calls[0][0] as Record<string, unknown>;
        expect(taskBody.story_id).toBeNull();
    });
});

// ─── runRecurringTaskSweep ─────────────────────────────────────────────

describe('runRecurringTaskSweep', () => {
    const sweepStub = (rows: unknown[]) => ({
        limit: () => sweepStub(rows),
        exec: () => Promise.resolve(rows),
    });

    const recurringTpl = (overrides: Record<string, unknown> = {}, recurrenceOverrides: Record<string, unknown> = {}) =>
        makeTemplate({
            ...overrides,
            recurrence: {
                enabled: true,
                frequency: 'daily',
                weekdays: [],
                day_of_month: null,
                start_date: '2026-01-01',
                end_date: null,
                last_generated_at: null,
                ...recurrenceOverrides,
            },
        });

    beforeEach(() => {
        userFindMock.mockReturnValue(queryStub([]));
        storyFindOneMock.mockReturnValue(findOneStub(null));
        sprintFindOneMock.mockReturnValue(findOneStub(null));
    });

    it('daily template fires every day in the window and stamps last_generated_at', async () => {
        const tpl = recurringTpl();
        templateFindMock.mockReturnValueOnce(sweepStub([tpl]));
        templateFindOneAndUpdateMock.mockResolvedValueOnce({ _id: tpl._id }); // stamp wins
        createTaskMock.mockResolvedValueOnce({ id: 'new-task-id' });

        const summary = await svc.runRecurringTaskSweep(new Date('2026-05-04T06:00:00+05:30'));

        expect(summary.tasks_created).toBe(1);
        expect(summary.skipped_already_today).toBe(0);
        // System audit row for the cron-driven instantiation.
        const audit = recordSystemAuditMock.mock.calls[0][0] as { action: string; metadata: { fire_date: string } };
        expect(audit.action).toBe(AUDIT_ACTIONS.TASK_TEMPLATE_RECURRENCE_RUN);
        expect(audit.metadata.fire_date).toBe('2026-05-04');
    });

    it('skips a template whose last_generated_at already equals today (idempotency)', async () => {
        const tpl = recurringTpl({}, { last_generated_at: '2026-05-04' });
        templateFindMock.mockReturnValueOnce(sweepStub([tpl]));

        const summary = await svc.runRecurringTaskSweep(new Date('2026-05-04T06:00:00+05:30'));

        expect(summary.tasks_created).toBe(0);
        expect(summary.skipped_already_today).toBe(1);
        expect(createTaskMock).not.toHaveBeenCalled();
    });

    it('skips a template whose start_date is in the future', async () => {
        const tpl = recurringTpl({}, { start_date: '2099-01-01' });
        templateFindMock.mockReturnValueOnce(sweepStub([tpl]));

        const summary = await svc.runRecurringTaskSweep(new Date('2026-05-04T06:00:00+05:30'));

        expect(summary.tasks_created).toBe(0);
        expect(createTaskMock).not.toHaveBeenCalled();
    });

    it('skips a template past its end_date', async () => {
        const tpl = recurringTpl({}, { end_date: '2025-12-31' });
        templateFindMock.mockReturnValueOnce(sweepStub([tpl]));

        const summary = await svc.runRecurringTaskSweep(new Date('2026-05-04T06:00:00+05:30'));

        expect(summary.tasks_created).toBe(0);
        expect(createTaskMock).not.toHaveBeenCalled();
    });

    it('weekly template fires only on listed weekdays', async () => {
        // 2026-05-04 is a Monday (weekday 1). Template wants Wed Fri (3, 5).
        const tpl = recurringTpl({}, { frequency: 'weekly', weekdays: [3, 5] });
        templateFindMock.mockReturnValueOnce(sweepStub([tpl]));

        const summary = await svc.runRecurringTaskSweep(new Date('2026-05-04T06:00:00+05:30'));

        expect(summary.tasks_created).toBe(0);
    });

    it('weekly template fires when today is in the weekday list', async () => {
        // Monday — template wants Mon (1).
        const tpl = recurringTpl({}, { frequency: 'weekly', weekdays: [1] });
        templateFindMock.mockReturnValueOnce(sweepStub([tpl]));
        templateFindOneAndUpdateMock.mockResolvedValueOnce({ _id: tpl._id });
        createTaskMock.mockResolvedValueOnce({ id: 'task' });

        const summary = await svc.runRecurringTaskSweep(new Date('2026-05-04T06:00:00+05:30'));

        expect(summary.tasks_created).toBe(1);
    });

    it('monthly template fires only on the listed day_of_month', async () => {
        // 2026-05-04 is the 4th of the month. Template wants the 15th.
        const tpl = recurringTpl({}, { frequency: 'monthly', day_of_month: 15 });
        templateFindMock.mockReturnValueOnce(sweepStub([tpl]));

        const summary = await svc.runRecurringTaskSweep(new Date('2026-05-04T06:00:00+05:30'));

        expect(summary.tasks_created).toBe(0);
    });

    it('per-template failure does NOT abort the rest of the sweep', async () => {
        const failing = recurringTpl();
        const ok = recurringTpl();
        templateFindMock.mockReturnValueOnce(sweepStub([failing, ok]));
        // First call throws, second succeeds.
        createTaskMock.mockRejectedValueOnce(new Error('mongo blip')).mockResolvedValueOnce({ id: 'task' });
        templateFindOneAndUpdateMock.mockResolvedValueOnce({ _id: ok._id });

        const summary = await svc.runRecurringTaskSweep(new Date('2026-05-04T06:00:00+05:30'));

        expect(summary.failures).toBe(1);
        expect(summary.tasks_created).toBe(1);
    });

    it('lost atomic stamp race produces a duplicate-warning failure (not silent)', async () => {
        const tpl = recurringTpl();
        templateFindMock.mockReturnValueOnce(sweepStub([tpl]));
        // Stamp returns null → race lost; the freshly-created task is a duplicate.
        templateFindOneAndUpdateMock.mockResolvedValueOnce(null);
        createTaskMock.mockResolvedValueOnce({ id: 'duplicate-task' });

        const summary = await svc.runRecurringTaskSweep(new Date('2026-05-04T06:00:00+05:30'));

        expect(summary.failures).toBe(1);
        expect(summary.tasks_created).toBe(0);
    });
});

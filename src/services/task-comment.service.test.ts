import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `task-comment.service` (Step 19).
 *
 * Coverage focus:
 *   1. Read/write project-visibility plumbing (404 on unknown task,
 *      403 from `loadProjectForCaller` propagated unchanged).
 *   2. Create — sanitisation (HTML stripped, body cap respected),
 *      mention scoping (member/client union enforced for ALL roles
 *      including author=client), de-duplication, dispatcher fan-out
 *      called with the cleaned body.
 *   3. Edit — author-only; admin/manager cannot rewrite somebody else's
 *      comment; new mentions trigger fan-out, removed mentions do not.
 *   4. Delete — author + admin/manager paths; soft-delete via
 *      `deleted_at`; soft-deleted rows behave like 404 for everyone.
 *   5. List — `include_deleted` only honoured for admin/manager.
 */

const {
    commentCreateMock,
    commentFindByIdMock,
    commentFindMock,
    commentCountDocumentsMock,
    taskFindByIdMock,
    loadProjectForCallerMock,
    notifyTaskCommentMentionMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    commentCreateMock: vi.fn(),
    commentFindByIdMock: vi.fn(),
    commentFindMock: vi.fn(),
    commentCountDocumentsMock: vi.fn(),
    taskFindByIdMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    notifyTaskCommentMentionMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/task-comment.model.js', () => ({
    TaskComment: {
        create: commentCreateMock,
        findById: commentFindByIdMock,
        find: commentFindMock,
        countDocuments: commentCountDocumentsMock,
    },
}));

vi.mock('../models/task.model.js', () => ({
    Task: { findById: taskFindByIdMock },
}));

vi.mock('./project.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./project.service.js')>();
    return {
        ...actual,
        loadProjectForCaller: loadProjectForCallerMock,
    };
});

vi.mock('./notification-dispatcher.service.js', () => ({
    notifyTaskCommentMention: notifyTaskCommentMentionMock,
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

vi.mock('./task-activity.service.js', () => ({
    recordActivity: vi.fn(),
    recordActivityIfChanged: vi.fn(),
}));

const svc = await import('./task-comment.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const adminCaller = () => ({ id: new Types.ObjectId(), role: ROLES.ADMIN, audit: undefined });
const managerCaller = () => ({ id: new Types.ObjectId(), role: ROLES.MANAGER, audit: undefined });
const employeeCaller = (id?: Types.ObjectId) => ({
    id: id ?? new Types.ObjectId(),
    role: ROLES.EMPLOYEE,
    audit: undefined,
});
const clientCaller = (id?: Types.ObjectId) => ({
    id: id ?? new Types.ObjectId(),
    role: ROLES.CLIENT,
    audit: undefined,
});

const makeProject = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    member_ids: [] as Types.ObjectId[],
    client_ids: [] as Types.ObjectId[],
    ...overrides,
});

const makeTaskRow = (project_id: Types.ObjectId) => ({
    _id: new Types.ObjectId(),
    project_id,
});

const stubTaskLookup = (taskRow: { _id: Types.ObjectId; project_id: Types.ObjectId } | null): void => {
    taskFindByIdMock.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(taskRow) }),
    });
};

const makeComment = (overrides: Record<string, unknown> = {}) => {
    const c = {
        _id: new Types.ObjectId(),
        task_id: new Types.ObjectId(),
        author_id: new Types.ObjectId(),
        body: 'hello',
        mentioned_user_ids: [] as Types.ObjectId[],
        is_edited: false,
        deleted_at: null as Date | null,
        created_at: new Date(),
        updated_at: new Date(),
        save: vi.fn(),
        toJSON: vi.fn(),
        ...overrides,
    };
    c.save.mockImplementation(async () => c);
    c.toJSON.mockImplementation(() => ({
        id: c._id.toString(),
        task_id: c.task_id.toString(),
        author_id: c.author_id.toString(),
        body: c.body,
        mentioned_user_ids: c.mentioned_user_ids.map((id) => id.toString()),
        is_edited: c.is_edited,
        deleted_at: c.deleted_at,
    }));
    return c;
};

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── createComment ───────────────────────────────────────────────────────

describe('createComment', () => {
    it('returns 404 when the underlying task is missing', async () => {
        stubTaskLookup(null);
        await expect(
            svc.createComment(new Types.ObjectId(), { body: 'hi', mentioned_user_ids: [] }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_NOT_FOUND });
        expect(loadProjectForCallerMock).not.toHaveBeenCalled();
    });

    it('propagates project-visibility 403 from loadProjectForCaller unchanged', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockRejectedValueOnce(
            Object.assign(new Error('Forbidden'), { code: ERROR_CODES.FORBIDDEN, statusCode: 403 })
        );
        await expect(
            svc.createComment(task._id, { body: 'hi', mentioned_user_ids: [] }, employeeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
        expect(commentCreateMock).not.toHaveBeenCalled();
    });

    it('strips HTML from the stored body and persists the cleaned text', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const created = makeComment({ task_id: task._id });
        commentCreateMock.mockResolvedValueOnce(created);

        await svc.createComment(
            task._id,
            { body: 'Hi <script>alert(1)</script><b>there</b>', mentioned_user_ids: [] },
            managerCaller()
        );

        expect(commentCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({ body: 'Hi there', mentioned_user_ids: [] })
        );
    });

    it('rejects when sanitisation reduces the body to empty', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(
            svc.createComment(task._id, { body: '<script>x</script>', mentioned_user_ids: [] }, managerCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
        expect(commentCreateMock).not.toHaveBeenCalled();
    });

    it('rejects mention of a user who is neither a project member nor client', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const stranger = new Types.ObjectId();
        await expect(
            svc.createComment(
                task._id,
                { body: 'hello @stranger', mentioned_user_ids: [stranger.toString()] },
                managerCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.MENTION_NOT_PROJECT_MEMBER });
        expect(commentCreateMock).not.toHaveBeenCalled();
    });

    it('accepts client-author mentioning a project member, dispatches notification once per unique mention', async () => {
        const memberA = new Types.ObjectId();
        const memberB = new Types.ObjectId();
        const author = new Types.ObjectId();
        const project = makeProject({ member_ids: [memberA, memberB], client_ids: [author] });
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const created = makeComment({ task_id: task._id, author_id: author });
        commentCreateMock.mockResolvedValueOnce(created);

        await svc.createComment(
            task._id,
            {
                body: 'hi team',
                // memberA appears twice — service must de-dupe before persist + dispatch
                mentioned_user_ids: [memberA.toString(), memberB.toString(), memberA.toString()],
            },
            clientCaller(author)
        );

        const persistedCall = commentCreateMock.mock.calls[0][0] as { mentioned_user_ids: Types.ObjectId[] };
        expect(persistedCall.mentioned_user_ids).toHaveLength(2);
        expect(notifyTaskCommentMentionMock).toHaveBeenCalledTimes(1);
        const dispatchArg = notifyTaskCommentMentionMock.mock.calls[0][0] as {
            mentioned_user_ids: Types.ObjectId[];
        };
        expect(dispatchArg.mentioned_user_ids).toHaveLength(2);
    });

    it('does not dispatch when there are no mentions', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const created = makeComment({ task_id: task._id });
        commentCreateMock.mockResolvedValueOnce(created);

        await svc.createComment(task._id, { body: 'no mentions here', mentioned_user_ids: [] }, managerCaller());
        expect(notifyTaskCommentMentionMock).not.toHaveBeenCalled();
    });
});

// ─── updateComment ───────────────────────────────────────────────────────

describe('updateComment', () => {
    it('rejects soft-deleted comments as 404', async () => {
        const c = makeComment({ deleted_at: new Date() });
        commentFindByIdMock.mockResolvedValueOnce(c);
        await expect(svc.updateComment(c._id, { body: 'x' }, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.COMMENT_NOT_FOUND,
        });
    });

    it('rejects edits by anyone other than the author (even an admin)', async () => {
        const project = makeProject();
        const c = makeComment({ author_id: new Types.ObjectId(), task_id: new Types.ObjectId() });
        commentFindByIdMock.mockResolvedValueOnce(c);
        stubTaskLookup({ _id: c.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.updateComment(c._id, { body: 'no' }, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.COMMENT_EDIT_FORBIDDEN,
        });
        expect(c.save).not.toHaveBeenCalled();
    });

    it('marks is_edited and persists sanitised body for the author', async () => {
        const project = makeProject();
        const author = new Types.ObjectId();
        const c = makeComment({ author_id: author, task_id: new Types.ObjectId() });
        commentFindByIdMock.mockResolvedValueOnce(c);
        stubTaskLookup({ _id: c.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await svc.updateComment(c._id, { body: '<i>updated</i>' }, employeeCaller(author));

        expect(c.body).toBe('updated');
        expect(c.is_edited).toBe(true);
        expect(c.save).toHaveBeenCalledTimes(1);
    });

    it('only fans out notifications for newly-added mentions', async () => {
        const member = new Types.ObjectId();
        const newMember = new Types.ObjectId();
        const project = makeProject({ member_ids: [member, newMember] });
        const author = new Types.ObjectId();
        const c = makeComment({
            author_id: author,
            task_id: new Types.ObjectId(),
            mentioned_user_ids: [member],
        });
        commentFindByIdMock.mockResolvedValueOnce(c);
        stubTaskLookup({ _id: c.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await svc.updateComment(
            c._id,
            { mentioned_user_ids: [member.toString(), newMember.toString()] },
            employeeCaller(author)
        );

        expect(notifyTaskCommentMentionMock).toHaveBeenCalledTimes(1);
        const dispatch = notifyTaskCommentMentionMock.mock.calls[0][0] as {
            mentioned_user_ids: Types.ObjectId[];
        };
        expect(dispatch.mentioned_user_ids.map(String)).toEqual([newMember.toString()]);
    });

    it('does not dispatch when the mention list is unchanged', async () => {
        const member = new Types.ObjectId();
        const project = makeProject({ member_ids: [member] });
        const author = new Types.ObjectId();
        const c = makeComment({
            author_id: author,
            task_id: new Types.ObjectId(),
            mentioned_user_ids: [member],
        });
        commentFindByIdMock.mockResolvedValueOnce(c);
        stubTaskLookup({ _id: c.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await svc.updateComment(
            c._id,
            { body: 'edited', mentioned_user_ids: [member.toString()] },
            employeeCaller(author)
        );

        expect(notifyTaskCommentMentionMock).not.toHaveBeenCalled();
    });
});

// ─── deleteComment ───────────────────────────────────────────────────────

describe('deleteComment', () => {
    it('allows the author to soft-delete their own comment', async () => {
        const project = makeProject();
        const author = new Types.ObjectId();
        const c = makeComment({ author_id: author, task_id: new Types.ObjectId() });
        commentFindByIdMock.mockResolvedValueOnce(c);
        stubTaskLookup({ _id: c.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const result = await svc.deleteComment(c._id, employeeCaller(author));
        expect(result).toEqual({ deleted: true });
        expect(c.deleted_at).toBeInstanceOf(Date);
        expect(c.save).toHaveBeenCalledTimes(1);
    });

    it('allows a manager to soft-delete somebody else’s comment (moderator)', async () => {
        const project = makeProject();
        const c = makeComment({ author_id: new Types.ObjectId(), task_id: new Types.ObjectId() });
        commentFindByIdMock.mockResolvedValueOnce(c);
        stubTaskLookup({ _id: c.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.deleteComment(c._id, managerCaller())).resolves.toEqual({ deleted: true });
        expect(c.deleted_at).toBeInstanceOf(Date);
    });

    it('rejects employee deleting somebody else’s comment with COMMENT_DELETE_FORBIDDEN', async () => {
        const project = makeProject();
        const c = makeComment({ author_id: new Types.ObjectId(), task_id: new Types.ObjectId() });
        commentFindByIdMock.mockResolvedValueOnce(c);
        stubTaskLookup({ _id: c.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.deleteComment(c._id, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.COMMENT_DELETE_FORBIDDEN,
        });
        expect(c.save).not.toHaveBeenCalled();
    });

    it('treats already soft-deleted comments as 404', async () => {
        const c = makeComment({ deleted_at: new Date() });
        commentFindByIdMock.mockResolvedValueOnce(c);
        await expect(svc.deleteComment(c._id, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.COMMENT_NOT_FOUND,
        });
    });
});

// ─── listComments ────────────────────────────────────────────────────────

describe('listComments', () => {
    const stubFindForList = (rows: ReturnType<typeof makeComment>[]): void => {
        commentFindMock.mockReturnValueOnce({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve(rows),
                }),
            }),
        });
        commentCountDocumentsMock.mockResolvedValueOnce(rows.length);
    };

    it('filters out soft-deleted rows for non-admins regardless of include_deleted flag', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindForList([]);

        await svc.listComments(task._id, { page: 1, limit: 20, include_deleted: true }, employeeCaller());

        expect(commentFindMock).toHaveBeenCalledWith(expect.objectContaining({ task_id: task._id, deleted_at: null }));
    });

    it('honours include_deleted when caller is admin', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindForList([]);

        await svc.listComments(task._id, { page: 1, limit: 20, include_deleted: true }, adminCaller());

        const filterArg = commentFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.task_id).toEqual(task._id);
        expect('deleted_at' in filterArg).toBe(false);
    });
});

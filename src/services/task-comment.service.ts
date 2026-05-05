import { Types } from 'mongoose';

import { TaskComment, type TaskCommentDocument } from '../models/task-comment.model.js';
import { Task } from '../models/task.model.js';
import type { ProjectDocument } from '../models/project.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { TASK_ACTIVITY_TYPES } from '../constants/task-activity.js';
import { recordAudit } from './audit.service.js';
import { recordActivity } from './task-activity.service.js';
import { loadProjectForCaller } from './project.service.js';
import type { ProjectCaller } from './project.service.js';
import { sanitiseCommentBody } from '../utils/comment-sanitiser.js';
import { notifyTaskCommentMention } from './notification-dispatcher.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { CreateCommentBody, ListCommentsQuery, PatchCommentBody } from '../validators/comment.validator.js';

/**
 * Task-comment service — Data_Model.md §5.5 / API_Contract.md §8.4.
 *
 * Architecture:
 *  - Reads + writes are project-scoped through `loadProjectForCaller`,
 *    so visibility is identical to the parent task.
 *  - Mention scoping is server-enforced in one place
 *    (`assertMentionsBelongToProject`) so adding a "client-only" rule
 *    later (or per-comment notification preferences) means touching one
 *    function. Every mention must be either a project member or client.
 *  - Body is sanitised by the service (not the validator) so the cap in
 *    the validator applies to the user's *raw* input — consistent with
 *    how the FE counts characters.
 *  - Soft-delete: we set `deleted_at` rather than removing the row, so
 *    the future activity feed (Step 20) can render "John deleted a
 *    comment" without juggling a separate tombstone collection.
 *  - Notifications: mention dispatch is fire-and-forget after the DB
 *    write succeeds. The dispatcher swallows its own errors per the
 *    `NOTIFICATION_DISPATCH_FAILED` policy, so a stuck mailbox can't
 *    block posting.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Step 47: Team Lead is a project author within their projects, so they
 * can moderate comments (edit / delete others' comments) on tasks inside
 * those projects — same authority a Manager has across the org.
 */
const isManagerOrAdmin = (role: string): boolean =>
    role === ROLES.ADMIN || role === ROLES.MANAGER || role === ROLES.TEAM_LEAD;

const toPublic = (doc: TaskCommentDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

/**
 * Load the parent task + assert the caller can see its project. All
 * comment endpoints fan through this so visibility lives in one place.
 */
const loadTaskAndProject = async (
    taskId: Types.ObjectId,
    caller: ProjectCaller
): Promise<{ task: { _id: Types.ObjectId; project_id: Types.ObjectId }; project: ProjectDocument }> => {
    const task = await Task.findById(taskId)
        .select('_id project_id')
        .lean<{ _id: Types.ObjectId; project_id: Types.ObjectId } | null>();
    if (!task) throw AppError.notFound('Task not found', ERROR_CODES.TASK_NOT_FOUND);
    const project = await loadProjectForCaller(task.project_id, caller);
    return { task, project };
};

/**
 * Confirm every mentioned user_id is a member or client of the project.
 * Per API_Contract §8.4 + BUILD_PROGRESS Step 19, this rule applies to
 * ALL authors (not just clients) — the explicit "clients can only mention
 * members/clients on the same project" line is a tighter restatement of
 * the same check, since clients have no other access to this project
 * anyway. Returns the de-duplicated mention list.
 */
const assertMentionsBelongToProject = (mentions: Types.ObjectId[], project: ProjectDocument): Types.ObjectId[] => {
    if (mentions.length === 0) return [];

    const projectUserSet = new Set<string>();
    for (const id of project.member_ids) projectUserSet.add(String(id));
    for (const id of project.client_ids) projectUserSet.add(String(id));

    // De-dupe while preserving order — a body that mentions @alice twice
    // shouldn't fan out two notifications.
    const seen = new Set<string>();
    const deduped: Types.ObjectId[] = [];
    const invalid: string[] = [];
    for (const id of mentions) {
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!projectUserSet.has(key)) {
            invalid.push(key);
            continue;
        }
        deduped.push(id);
    }

    if (invalid.length > 0) {
        throw AppError.unprocessable(
            'One or more mentioned users are not members or clients of this project',
            ERROR_CODES.MENTION_NOT_PROJECT_MEMBER,
            { invalid_user_ids: invalid }
        );
    }
    return deduped;
};

const loadCommentForAccess = async (
    commentId: Types.ObjectId,
    caller: ProjectCaller
): Promise<{ comment: TaskCommentDocument; project: ProjectDocument }> => {
    const comment = await TaskComment.findById(commentId);
    if (!comment || comment.deleted_at !== null) {
        // Soft-deleted comments behave like a 404 for everyone — the
        // audit log keeps the original body for the regulatory trail.
        throw AppError.notFound('Comment not found', ERROR_CODES.COMMENT_NOT_FOUND);
    }
    const { project } = await loadTaskAndProject(comment.task_id, caller);
    return { comment, project };
};

// ─── GET /tasks/:task_id/comments ─────────────────────────────────────────

export const listComments = async (
    taskId: Types.ObjectId,
    query: ListCommentsQuery,
    caller: ProjectCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    await loadTaskAndProject(taskId, caller);

    const filter: Record<string, unknown> = { task_id: taskId };
    // `include_deleted` is an admin/manager affordance for moderation
    // tooling; everyone else gets the live-only view.
    if (!(query.include_deleted && isManagerOrAdmin(caller.role))) {
        filter.deleted_at = null;
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        TaskComment.find(filter).sort({ created_at: 1, _id: 1 }).skip(skip).limit(query.limit),
        TaskComment.countDocuments(filter),
    ]);

    return {
        data: rows.map(toPublic),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── POST /tasks/:task_id/comments ────────────────────────────────────────

export const createComment = async (
    taskId: Types.ObjectId,
    input: CreateCommentBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const { task, project } = await loadTaskAndProject(taskId, caller);

    const { text: cleanBody } = sanitiseCommentBody(input.body);
    if (cleanBody.length === 0) {
        // Sanitisation reduced the body to whitespace (e.g. "<script>x</script>"
        // alone). Treat as an empty body even though the validator's
        // length check passed against the raw input.
        throw AppError.validation('Comment body is empty after sanitisation');
    }

    const rawMentions = (input.mentioned_user_ids ?? []).map((id) => new Types.ObjectId(id));
    const mentions = assertMentionsBelongToProject(rawMentions, project);

    const created = await TaskComment.create({
        task_id: task._id,
        author_id: caller.id,
        body: cleanBody,
        mentioned_user_ids: mentions,
        is_edited: false,
        deleted_at: null,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.COMMENT_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.COMMENT, id: created._id },
            after: toPublic(created),
            metadata: {
                task_id: task._id.toString(),
                project_id: project._id.toString(),
                mention_count: mentions.length,
            },
        });
    }

    if (mentions.length > 0) {
        // Fire-and-forget. The dispatcher logs its own failures and
        // never throws — the comment write is the user's primary
        // success signal.
        await notifyTaskCommentMention({
            comment_id: created._id,
            task_id: task._id,
            project_id: project._id,
            author_id: caller.id,
            mentioned_user_ids: mentions,
            body_preview: cleanBody,
        });
    }

    await recordActivity({
        task_id: task._id,
        actor_id: caller.id,
        activity_type: TASK_ACTIVITY_TYPES.COMMENT_ADDED,
        to_value: created._id,
        metadata: { comment_id: created._id.toString(), mention_count: mentions.length },
    });

    return toPublic(created);
};

// ─── PATCH /comments/:id ──────────────────────────────────────────────────
//
// Edit is **author-only**. Even admins/managers cannot rewrite somebody
// else's words — they can soft-delete the row through DELETE /comments/:id
// (admin/manager fallback) but never silently change the body. This
// matches the Slack/GitHub authorship model.

export const updateComment = async (
    commentId: Types.ObjectId,
    patch: PatchCommentBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const { comment, project } = await loadCommentForAccess(commentId, caller);

    if (!comment.author_id.equals(caller.id)) {
        throw AppError.forbidden('Only the author can edit this comment', ERROR_CODES.COMMENT_EDIT_FORBIDDEN);
    }

    const before = toPublic(comment);
    let mentionDelta: Types.ObjectId[] = [];

    if (patch.body !== undefined) {
        const { text: cleanBody } = sanitiseCommentBody(patch.body);
        if (cleanBody.length === 0) {
            throw AppError.validation('Comment body is empty after sanitisation');
        }
        comment.body = cleanBody;
    }

    if (patch.mentioned_user_ids !== undefined) {
        const rawMentions = patch.mentioned_user_ids.map((id) => new Types.ObjectId(id));
        const newMentions = assertMentionsBelongToProject(rawMentions, project);

        const previous = new Set(comment.mentioned_user_ids.map((id) => String(id)));
        // Only newly-introduced mentions trigger fan-out — re-saving the
        // same mention list shouldn't re-notify everyone.
        mentionDelta = newMentions.filter((id) => !previous.has(String(id)));
        comment.mentioned_user_ids = newMentions;
    }

    comment.is_edited = true;
    await comment.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.COMMENT_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.COMMENT, id: comment._id },
            before,
            after: toPublic(comment),
            metadata: {
                task_id: comment.task_id.toString(),
                project_id: project._id.toString(),
                new_mention_count: mentionDelta.length,
            },
        });
    }

    if (mentionDelta.length > 0) {
        await notifyTaskCommentMention({
            comment_id: comment._id,
            task_id: comment.task_id,
            project_id: project._id,
            author_id: caller.id,
            mentioned_user_ids: mentionDelta,
            body_preview: comment.body,
        });
    }

    await recordActivity({
        task_id: comment.task_id,
        actor_id: caller.id,
        activity_type: TASK_ACTIVITY_TYPES.COMMENT_EDITED,
        to_value: comment._id,
        metadata: { comment_id: comment._id.toString() },
    });

    return toPublic(comment);
};

// ─── DELETE /comments/:id ─────────────────────────────────────────────────
//
// Author OR admin/manager. The author always wins their own comment;
// admins/managers act as moderators. Employees and clients cannot delete
// somebody else's comment — even an employee who is an assignee on the
// underlying task. Soft-delete (sets `deleted_at`).

export const deleteComment = async (commentId: Types.ObjectId, caller: ProjectCaller): Promise<{ deleted: true }> => {
    const { comment, project } = await loadCommentForAccess(commentId, caller);

    const isAuthor = comment.author_id.equals(caller.id);
    if (!isAuthor && !isManagerOrAdmin(caller.role)) {
        throw AppError.forbidden(
            'Only the author or an admin/manager can delete this comment',
            ERROR_CODES.COMMENT_DELETE_FORBIDDEN
        );
    }

    const before = toPublic(comment);
    comment.deleted_at = new Date();
    await comment.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.COMMENT_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.COMMENT, id: comment._id },
            before,
            metadata: {
                task_id: comment.task_id.toString(),
                project_id: project._id.toString(),
                deleted_by: isAuthor ? 'author' : 'moderator',
            },
        });
    }

    await recordActivity({
        task_id: comment.task_id,
        actor_id: caller.id,
        activity_type: TASK_ACTIVITY_TYPES.COMMENT_DELETED,
        from_value: comment._id,
        metadata: {
            comment_id: comment._id.toString(),
            deleted_by: isAuthor ? 'author' : 'moderator',
        },
    });

    return { deleted: true };
};

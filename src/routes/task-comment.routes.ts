import { Router } from 'express';

import * as ctrl from '../controllers/task-comment.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    commentIdPathSchema,
    createCommentBodySchema,
    listCommentsQuerySchema,
    patchCommentBodySchema,
    taskIdPathSchema,
} from '../validators/comment.validator.js';

/**
 * Task-comment routes (Step 19; API_Contract.md §8.4).
 *
 * Two routers because the API splits the resource across nested + top-
 * level URLs:
 *   - `/tasks/:task_id/comments`       (list, create)
 *   - `/comments/:id`                  (patch, delete)
 *
 * Both share the same role gate (any role with project read access can
 * post; the service decides per-row author/admin permissions for edit
 * and delete).
 */

// ─── Nested under /tasks/:task_id/comments ───────────────────────────────

export const taskCommentsNestedRouter = (): Router => {
    const router = Router({ mergeParams: true });
    router.use(authenticate);

    router.get(
        '/:task_id/comments',
        requirePermission(PERMISSIONS.TASK_READ),
        validate({ params: taskIdPathSchema, query: listCommentsQuerySchema }),
        asyncHandler(ctrl.getList)
    );

    router.post(
        '/:task_id/comments',
        requirePermission(PERMISSIONS.TASK_COMMENT_WRITE),
        validate({ params: taskIdPathSchema, body: createCommentBodySchema }),
        asyncHandler(ctrl.postCreate)
    );

    return router;
};

// ─── Top-level /comments/:id ─────────────────────────────────────────────

export const commentsRouter = (): Router => {
    const router = Router();
    router.use(authenticate);

    router.patch(
        '/:id',
        requirePermission(PERMISSIONS.TASK_COMMENT_WRITE),
        validate({ params: commentIdPathSchema, body: patchCommentBodySchema }),
        asyncHandler(ctrl.patchOne)
    );

    router.delete(
        '/:id',
        requirePermission(PERMISSIONS.TASK_COMMENT_WRITE),
        validate({ params: commentIdPathSchema }),
        asyncHandler(ctrl.deleteOne)
    );

    return router;
};

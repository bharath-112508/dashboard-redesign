import { Router } from 'express';

import * as ctrl from '../controllers/task-comment.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { COMMENT_READ_ROLES, COMMENT_WRITE_ROLES } from '../constants/comment.js';
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
        authorize(...COMMENT_READ_ROLES),
        validate({ params: taskIdPathSchema, query: listCommentsQuerySchema }),
        asyncHandler(ctrl.getList)
    );

    router.post(
        '/:task_id/comments',
        authorize(...COMMENT_WRITE_ROLES),
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
        authorize(...COMMENT_WRITE_ROLES),
        validate({ params: commentIdPathSchema, body: patchCommentBodySchema }),
        asyncHandler(ctrl.patchOne)
    );

    router.delete(
        '/:id',
        authorize(...COMMENT_WRITE_ROLES),
        validate({ params: commentIdPathSchema }),
        asyncHandler(ctrl.deleteOne)
    );

    return router;
};

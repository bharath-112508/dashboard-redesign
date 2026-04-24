import { Router } from 'express';

import * as ctrl from '../controllers/task-activity.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { ACTIVITY_READ_ROLES } from '../constants/task-activity.js';
import { listActivitiesQuerySchema, taskActivityPathSchema } from '../validators/task-activity.validator.js';

/**
 * Task-activity routes (Step 20; API_Contract.md §8.6).
 *
 * Mounted under `/tasks` so the URL is `/tasks/:task_id/activity`.
 * Project visibility is enforced by the service via
 * `loadProjectForCaller`; the route-level role gate just keeps random
 * authenticated users (no project access at all) from probing.
 *
 * No POST/PATCH/DELETE in Phase 1 — activity rows are produced by the
 * task / task-comment service hooks.
 */

export const taskActivityRouter = (): Router => {
    const router = Router({ mergeParams: true });
    router.use(authenticate);

    router.get(
        '/:task_id/activity',
        authorize(...ACTIVITY_READ_ROLES),
        validate({ params: taskActivityPathSchema, query: listActivitiesQuerySchema }),
        asyncHandler(ctrl.getList)
    );

    return router;
};

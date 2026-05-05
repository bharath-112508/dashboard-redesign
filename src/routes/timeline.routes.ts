import { Router } from 'express';

import * as ctrl from '../controllers/timeline.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { projectIdParamSchema, timelineQuerySchema } from '../validators/timeline.validator.js';

/**
 * Timeline / Gantt routes (Phase 4 Step 41).
 *
 * One read-only endpoint nested under projects:
 *   `GET /projects/:project_id/timeline?from_date=&to_date=&...`
 *
 * Mounted as a project-nested router (mirrors the share-link nested
 * pattern from Step 24) so the URL matches the natural data hierarchy.
 */
export const projectTimelineNestedRouter = (): Router => {
    const router = Router({ mergeParams: true });

    router.use(authenticate);

    router.get(
        '/',
        requirePermission(PERMISSIONS.PROJECT_READ),
        validate({ params: projectIdParamSchema, query: timelineQuerySchema }),
        asyncHandler(ctrl.getTimeline)
    );

    return router;
};

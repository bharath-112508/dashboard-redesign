import { Router } from 'express';

import * as ctrl from '../controllers/story.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    listStoryTasksQuerySchema,
    patchStoryBodySchema,
    reorderStoryBodySchema,
    storyIdParamSchema,
} from '../validators/story.validator.js';

/**
 * Top-level story routes — `/stories/:id` item operations.
 *
 * The nested create + list endpoints live on `project.routes.ts` so they
 * share the project router's `:project_id` URL namespace (mirrors the
 * pattern used for sprints in Step 16).
 */

const router = Router();

router.use(authenticate);

// ─── /stories/:id ────────────────────────────────────────────────────────

router.get(
    '/:id',
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ params: storyIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.STORY_WRITE),
    validate({ params: storyIdParamSchema, body: patchStoryBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.STORY_WRITE),
    validate({ params: storyIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

router.post(
    '/:id/reorder',
    requirePermission(PERMISSIONS.STORY_WRITE),
    validate({ params: storyIdParamSchema, body: reorderStoryBodySchema }),
    asyncHandler(ctrl.postReorder)
);

router.get(
    '/:id/tasks',
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ params: storyIdParamSchema, query: listStoryTasksQuerySchema }),
    asyncHandler(ctrl.getTasks)
);

export default router;

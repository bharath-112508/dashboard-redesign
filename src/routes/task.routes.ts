import { Router } from 'express';

import * as ctrl from '../controllers/task.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    addDependencyBodySchema,
    assignStoryBodySchema,
    createTaskBodySchema,
    listTasksQuerySchema,
    moveSprintBodySchema,
    patchTaskBodySchema,
    rankTaskBodySchema,
    reorderTaskBodySchema,
    taskDependencyParamsSchema,
    taskIdParamSchema,
} from '../validators/task.validator.js';

/**
 * Task routes — `/tasks` (list, create, item, sub-actions).
 *
 * Authorisation matrix (defence in depth — service re-checks):
 *   - GET   /tasks                       READ  (scoped per project visibility)
 *   - GET   /tasks/:id                   READ  (project access)
 *   - POST  /tasks                       WRITE (admin / manager)
 *   - PATCH /tasks/:id                   PATCH (admin / manager / employee-own)
 *   - DELETE /tasks/:id                  WRITE
 *   - POST  /tasks/:id/reorder           READ at route level — service narrows
 *                                        to admin/manager OR the assignee.
 *   - POST  /tasks/:id/assign-story      WRITE — but throws STORY_WRITE_FORBIDDEN
 *                                        (per API_Contract §8.2a; story-write
 *                                        op semantically).
 *   - POST  /tasks/:id/move-sprint       WRITE
 *   - POST  /tasks/:id/dependencies      WRITE
 *   - DELETE /tasks/:id/dependencies/:dep_id  WRITE
 */

const router = Router();

router.use(authenticate);

// ─── List + create ───────────────────────────────────────────────────────

router.get(
    '/',
    requirePermission(PERMISSIONS.TASK_READ),
    validate({ query: listTasksQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.TASK_WRITE),
    validate({ body: createTaskBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// ─── Item ────────────────────────────────────────────────────────────────

router.get(
    '/:id',
    requirePermission(PERMISSIONS.TASK_READ),
    validate({ params: taskIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.TASK_WRITE),
    validate({ params: taskIdParamSchema, body: patchTaskBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.TASK_WRITE),
    validate({ params: taskIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

// ─── Sub-actions ─────────────────────────────────────────────────────────

router.post(
    '/:id/reorder',
    // Reorder is open to all read-roles at the route gate; the service
    // restricts to admin/manager OR the task's assignee. Putting the role
    // check there keeps the assignee logic in one place rather than
    // requiring a custom middleware that needs to load the task.
    requirePermission(PERMISSIONS.TASK_READ),
    validate({ params: taskIdParamSchema, body: reorderTaskBodySchema }),
    asyncHandler(ctrl.postReorder)
);

// Phase 2 Backlog — reorder within the per-project backlog_rank ordering.
// Gated on TASK_WRITE (employees hold it); the service further restricts to
// admin/manager/team_lead OR the task's assignee, mirroring reorder.
router.post(
    '/:id/rank',
    requirePermission(PERMISSIONS.TASK_WRITE),
    validate({ params: taskIdParamSchema, body: rankTaskBodySchema }),
    asyncHandler(ctrl.postRank)
);

router.post(
    '/:id/assign-story',
    requirePermission(PERMISSIONS.TASK_WRITE),
    validate({ params: taskIdParamSchema, body: assignStoryBodySchema }),
    asyncHandler(ctrl.postAssignStory)
);

router.post(
    '/:id/move-sprint',
    requirePermission(PERMISSIONS.TASK_WRITE),
    validate({ params: taskIdParamSchema, body: moveSprintBodySchema }),
    asyncHandler(ctrl.postMoveSprint)
);

router.post(
    '/:id/dependencies',
    requirePermission(PERMISSIONS.TASK_WRITE),
    validate({ params: taskIdParamSchema, body: addDependencyBodySchema }),
    asyncHandler(ctrl.postAddDependency)
);

router.delete(
    '/:id/dependencies/:dep_id',
    requirePermission(PERMISSIONS.TASK_WRITE),
    validate({ params: taskDependencyParamsSchema }),
    asyncHandler(ctrl.deleteDependency)
);

export default router;

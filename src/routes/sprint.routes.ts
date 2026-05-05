import { Router } from 'express';

import * as ctrl from '../controllers/sprint.controller.js';
import * as projectCtrl from '../controllers/project.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { patchSprintBodySchema, sprintIdParamSchema } from '../validators/sprint.validator.js';
import { customStatusIdParamSchema, patchCustomStatusBodySchema } from '../validators/project.validator.js';

/**
 * Top-level item routes for sprints + custom statuses.
 *
 *  - `/sprints/:id` — get / patch / delete one sprint by its own id
 *    (nested create + list are on `project.routes.ts` so they share the
 *    project's `:project_id` URL prefix).
 *  - `/project-custom-statuses/:id` — patch / delete one custom-status sub-doc
 *    by its sub-doc ObjectId. The owning project is resolved server-side via
 *    the partial index on `custom_task_statuses._id`.
 */

const router = Router();

router.use(authenticate);

// ─── /sprints/:id ────────────────────────────────────────────────────────

router.get(
    '/:id',
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ params: sprintIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.SPRINT_WRITE),
    validate({ params: sprintIdParamSchema, body: patchSprintBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.SPRINT_WRITE),
    validate({ params: sprintIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

// T11 — archive / unarchive endpoints. Archive is the operator's
// escape hatch for "decommission a sprint with lingering tasks
// without forcing a status transition". Once archived, `deleteOne`
// permits the delete even with dependant tasks.
router.post(
    '/:id/archive',
    requirePermission(PERMISSIONS.SPRINT_WRITE),
    validate({ params: sprintIdParamSchema }),
    asyncHandler(ctrl.postArchive)
);

router.post(
    '/:id/unarchive',
    requirePermission(PERMISSIONS.SPRINT_WRITE),
    validate({ params: sprintIdParamSchema }),
    asyncHandler(ctrl.postUnarchive)
);

export default router;

// Re-exported separately so the index router can mount it on a different path.
export const customStatusRouter = (): Router => {
    const r = Router();
    r.use(authenticate);

    r.patch(
        '/:id',
        requirePermission(PERMISSIONS.PROJECT_WRITE),
        validate({ params: customStatusIdParamSchema, body: patchCustomStatusBodySchema }),
        asyncHandler(projectCtrl.patchCustomStatus)
    );

    r.delete(
        '/:id',
        requirePermission(PERMISSIONS.PROJECT_WRITE),
        validate({ params: customStatusIdParamSchema }),
        asyncHandler(projectCtrl.deleteCustomStatus)
    );

    return r;
};

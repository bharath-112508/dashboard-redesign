import { Router } from 'express';

import * as ctrl from '../controllers/sprint.controller.js';
import * as projectCtrl from '../controllers/project.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PROJECT_READ_ROLES, PROJECT_WRITE_ROLES } from '../constants/project.js';
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
    authorize(...PROJECT_READ_ROLES),
    validate({ params: sprintIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: sprintIdParamSchema, body: patchSprintBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: sprintIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

// Re-exported separately so the index router can mount it on a different path.
export const customStatusRouter = (): Router => {
    const r = Router();
    r.use(authenticate);

    r.patch(
        '/:id',
        authorize(...PROJECT_WRITE_ROLES),
        validate({ params: customStatusIdParamSchema, body: patchCustomStatusBodySchema }),
        asyncHandler(projectCtrl.patchCustomStatus)
    );

    r.delete(
        '/:id',
        authorize(...PROJECT_WRITE_ROLES),
        validate({ params: customStatusIdParamSchema }),
        asyncHandler(projectCtrl.deleteCustomStatus)
    );

    return r;
};

import { Router } from 'express';

import * as ctrl from '../controllers/task-template.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { TASK_TEMPLATE_READ_ROLES, TASK_TEMPLATE_WRITE_ROLES } from '../constants/task-template.js';
import {
    createTaskTemplateBodySchema,
    instantiateTaskTemplateBodySchema,
    listTaskTemplatesQuerySchema,
    patchTaskTemplateBodySchema,
    projectIdParamSchema,
    taskTemplateIdParamSchema,
} from '../validators/task-template.validator.js';

/**
 * Task-template routes (Phase 4 Step 40).
 *
 * Mounted in two places (mirrors the project / sprint pattern):
 *  - **Project-nested router** at `/projects/:project_id/task-templates`
 *    handles list + create. Read = project visibility; write = admin/manager.
 *  - **Top-level router** at `/task-templates/:id` handles detail / patch /
 *    delete / instantiate by id.
 */

// ─── Project-nested (list + create) ─────────────────────────────────────

export const projectNestedRouter = (): Router => {
    const router = Router({ mergeParams: true });

    router.use(authenticate);

    router.get(
        '/',
        authorize(...TASK_TEMPLATE_READ_ROLES),
        validate({ params: projectIdParamSchema, query: listTaskTemplatesQuerySchema }),
        asyncHandler(ctrl.getList)
    );

    router.post(
        '/',
        authorize(...TASK_TEMPLATE_WRITE_ROLES),
        validate({ params: projectIdParamSchema, body: createTaskTemplateBodySchema }),
        asyncHandler(ctrl.postCreate)
    );

    return router;
};

// ─── Top-level by id ───────────────────────────────────────────────────

const router = Router();
router.use(authenticate);

router.get(
    '/:id',
    authorize(...TASK_TEMPLATE_READ_ROLES),
    validate({ params: taskTemplateIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    authorize(...TASK_TEMPLATE_WRITE_ROLES),
    validate({ params: taskTemplateIdParamSchema, body: patchTaskTemplateBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    authorize(...TASK_TEMPLATE_WRITE_ROLES),
    validate({ params: taskTemplateIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

router.post(
    '/:id/instantiate',
    authorize(...TASK_TEMPLATE_WRITE_ROLES),
    validate({ params: taskTemplateIdParamSchema, body: instantiateTaskTemplateBodySchema }),
    asyncHandler(ctrl.postInstantiate)
);

export default router;

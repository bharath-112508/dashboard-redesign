import { Router } from 'express';

import * as ctrl from '../controllers/task-template.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
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
        requirePermission(PERMISSIONS.TASK_TEMPLATE_READ),
        validate({ params: projectIdParamSchema, query: listTaskTemplatesQuerySchema }),
        asyncHandler(ctrl.getList)
    );

    router.post(
        '/',
        requirePermission(PERMISSIONS.TASK_TEMPLATE_WRITE),
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
    requirePermission(PERMISSIONS.TASK_TEMPLATE_READ),
    validate({ params: taskTemplateIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.TASK_TEMPLATE_WRITE),
    validate({ params: taskTemplateIdParamSchema, body: patchTaskTemplateBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.TASK_TEMPLATE_WRITE),
    validate({ params: taskTemplateIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

router.post(
    '/:id/instantiate',
    requirePermission(PERMISSIONS.TASK_TEMPLATE_WRITE),
    validate({ params: taskTemplateIdParamSchema, body: instantiateTaskTemplateBodySchema }),
    asyncHandler(ctrl.postInstantiate)
);

export default router;

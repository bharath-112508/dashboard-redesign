import { Router } from 'express';

import * as ctrl from '../controllers/leave-type.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    createLeaveTypeBodySchema,
    leaveTypeIdParamSchema,
    listLeaveTypesQuerySchema,
    patchLeaveTypeBodySchema,
} from '../validators/leave-type.validator.js';

const router = Router();
router.use(authenticate);

router.get(
    '/',
    requirePermission(PERMISSIONS.LEAVE_TYPE_READ),
    validate({ query: listLeaveTypesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.LEAVE_TYPE_WRITE),
    validate({ body: createLeaveTypeBodySchema }),
    asyncHandler(ctrl.postCreate)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.LEAVE_TYPE_WRITE),
    validate({ params: leaveTypeIdParamSchema, body: patchLeaveTypeBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.post(
    '/:id/deactivate',
    requirePermission(PERMISSIONS.LEAVE_TYPE_WRITE),
    validate({ params: leaveTypeIdParamSchema }),
    asyncHandler(ctrl.deactivate)
);

export default router;

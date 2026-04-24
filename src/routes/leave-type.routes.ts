import { Router } from 'express';

import * as ctrl from '../controllers/leave-type.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { LEAVE_TYPE_READ_ROLES, LEAVE_TYPE_WRITE_ROLES } from '../constants/leave.js';
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
    authorize(...LEAVE_TYPE_READ_ROLES),
    validate({ query: listLeaveTypesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    authorize(...LEAVE_TYPE_WRITE_ROLES),
    validate({ body: createLeaveTypeBodySchema }),
    asyncHandler(ctrl.postCreate)
);

router.patch(
    '/:id',
    authorize(...LEAVE_TYPE_WRITE_ROLES),
    validate({ params: leaveTypeIdParamSchema, body: patchLeaveTypeBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.post(
    '/:id/deactivate',
    authorize(...LEAVE_TYPE_WRITE_ROLES),
    validate({ params: leaveTypeIdParamSchema }),
    asyncHandler(ctrl.deactivate)
);

export default router;

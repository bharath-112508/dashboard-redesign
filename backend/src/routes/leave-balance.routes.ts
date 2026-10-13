import { Router } from 'express';

import * as ctrl from '../controllers/leave-balance.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    adjustLeaveBalanceBodySchema,
    initializeYearBodySchema,
    leaveBalanceIdParamSchema,
    listLeaveBalancesQuerySchema,
    myBalancesQuerySchema,
} from '../validators/leave-balance.validator.js';

const router = Router();
router.use(authenticate);

// `/me` MUST come before any `/:something` patterns so Express doesn't
// misinterpret `me` as the resource id.
router.get('/me', validate({ query: myBalancesQuerySchema }), asyncHandler(ctrl.getMine));

router.get(
    '/',
    requirePermission(PERMISSIONS.LEAVE_BALANCE_READ_TEAM),
    validate({ query: listLeaveBalancesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/initialize-year',
    requirePermission(PERMISSIONS.LEAVE_BALANCE_ADJUST),
    validate({ body: initializeYearBodySchema }),
    asyncHandler(ctrl.postInitializeYear)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.LEAVE_BALANCE_ADJUST),
    validate({ params: leaveBalanceIdParamSchema, body: adjustLeaveBalanceBodySchema }),
    asyncHandler(ctrl.patchOne)
);

export default router;

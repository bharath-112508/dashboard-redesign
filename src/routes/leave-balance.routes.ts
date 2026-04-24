import { Router } from 'express';

import * as ctrl from '../controllers/leave-balance.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { LEAVE_BALANCE_ADJUST_ROLES, LEAVE_BALANCE_LIST_ROLES } from '../constants/leave.js';
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
    authorize(...LEAVE_BALANCE_LIST_ROLES),
    validate({ query: listLeaveBalancesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/initialize-year',
    authorize(...LEAVE_BALANCE_ADJUST_ROLES),
    validate({ body: initializeYearBodySchema }),
    asyncHandler(ctrl.postInitializeYear)
);

router.patch(
    '/:id',
    authorize(...LEAVE_BALANCE_ADJUST_ROLES),
    validate({ params: leaveBalanceIdParamSchema, body: adjustLeaveBalanceBodySchema }),
    asyncHandler(ctrl.patchOne)
);

export default router;

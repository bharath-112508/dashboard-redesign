import { Router } from 'express';

import * as ctrl from '../controllers/leave-request.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    applyLeaveBodySchema,
    approveLeaveBodySchema,
    calendarLeavesQuerySchema,
    cancelLeaveBodySchema,
    leaveIdParamSchema,
    listLeavesQuerySchema,
    rejectLeaveBodySchema,
} from '../validators/leave-request.validator.js';

const router = Router();
router.use(authenticate);

// All collection-level routes must come BEFORE `/:id` so Express can match
// the literal segment names (`preview-split`, `calendar`).

router.post(
    '/preview-split',
    requirePermission(PERMISSIONS.LEAVE_REQUEST_WRITE),
    validate({ body: applyLeaveBodySchema }),
    asyncHandler(ctrl.postPreview)
);

router.get('/calendar', validate({ query: calendarLeavesQuerySchema }), asyncHandler(ctrl.getCalendar));

router.get('/', validate({ query: listLeavesQuerySchema }), asyncHandler(ctrl.getList));

router.post(
    '/',
    requirePermission(PERMISSIONS.LEAVE_REQUEST_WRITE),
    validate({ body: applyLeaveBodySchema }),
    asyncHandler(ctrl.postApply)
);

router.get('/:id', validate({ params: leaveIdParamSchema }), asyncHandler(ctrl.getOne));

router.post(
    '/:id/approve',
    requirePermission(PERMISSIONS.LEAVE_REQUEST_APPROVE),
    validate({ params: leaveIdParamSchema, body: approveLeaveBodySchema }),
    asyncHandler(ctrl.postApprove)
);

router.post(
    '/:id/reject',
    requirePermission(PERMISSIONS.LEAVE_REQUEST_APPROVE),
    validate({ params: leaveIdParamSchema, body: rejectLeaveBodySchema }),
    asyncHandler(ctrl.postReject)
);

router.post(
    '/:id/cancel',
    validate({ params: leaveIdParamSchema, body: cancelLeaveBodySchema }),
    asyncHandler(ctrl.postCancel)
);

export default router;

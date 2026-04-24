import { Router } from 'express';

import * as ctrl from '../controllers/leave-request.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
    LEAVE_REQUEST_APPLY_ROLES,
    LEAVE_REQUEST_LIST_ALL_ROLES,
    LEAVE_REQUEST_REVIEW_ROLES,
} from '../constants/leave.js';
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
    authorize(...LEAVE_REQUEST_APPLY_ROLES),
    validate({ body: applyLeaveBodySchema }),
    asyncHandler(ctrl.postPreview)
);

router.get('/calendar', validate({ query: calendarLeavesQuerySchema }), asyncHandler(ctrl.getCalendar));

router.get('/', validate({ query: listLeavesQuerySchema }), asyncHandler(ctrl.getList));

router.post(
    '/',
    authorize(...LEAVE_REQUEST_APPLY_ROLES),
    validate({ body: applyLeaveBodySchema }),
    asyncHandler(ctrl.postApply)
);

router.get('/:id', validate({ params: leaveIdParamSchema }), asyncHandler(ctrl.getOne));

router.post(
    '/:id/approve',
    authorize(...LEAVE_REQUEST_REVIEW_ROLES),
    validate({ params: leaveIdParamSchema, body: approveLeaveBodySchema }),
    asyncHandler(ctrl.postApprove)
);

router.post(
    '/:id/reject',
    authorize(...LEAVE_REQUEST_REVIEW_ROLES),
    validate({ params: leaveIdParamSchema, body: rejectLeaveBodySchema }),
    asyncHandler(ctrl.postReject)
);

router.post(
    '/:id/cancel',
    validate({ params: leaveIdParamSchema, body: cancelLeaveBodySchema }),
    asyncHandler(ctrl.postCancel)
);

void LEAVE_REQUEST_LIST_ALL_ROLES;

export default router;

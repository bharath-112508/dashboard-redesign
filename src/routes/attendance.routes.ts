import { Router } from 'express';

import * as ctrl from '../controllers/attendance.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { ATTENDANCE_INTERNAL_ROLES, ATTENDANCE_REVIEW_ROLES } from '../constants/attendance.js';
import {
    attendanceIdParamSchema,
    checkInBodySchema,
    checkOutBodySchema,
    correctionRequestIdParamSchema,
    listAttendanceQuerySchema,
    listCorrectionsQuerySchema,
    myAttendanceQuerySchema,
    patchAttendanceBodySchema,
    qrVerifyBodySchema,
    reviewCorrectionBodySchema,
    submitCorrectionBodySchema,
} from '../validators/attendance.validator.js';

const router = Router();

// All routes require an authenticated internal user (admin / manager /
// employee). Clients have no attendance records and would only ever see 403s.
router.use(authenticate, authorize(...ATTENDANCE_INTERNAL_ROLES));

// ─── Employee-facing collection routes ────────────────────────────────────
// NB: Order matters — `/me/today` must come before any `/:id` parameterised
// route, and `/correction-requests` (collection) must come before
// `/correction-requests/:id/...` for the Express matcher.

router.post('/check-in', validate({ body: checkInBodySchema }), asyncHandler(ctrl.postCheckIn));

router.post('/check-out', validate({ body: checkOutBodySchema }), asyncHandler(ctrl.postCheckOut));

router.post('/qr-verify', validate({ body: qrVerifyBodySchema }), asyncHandler(ctrl.postQrVerify));

router.get('/me/today', asyncHandler(ctrl.getMyToday));

router.get('/me', validate({ query: myAttendanceQuerySchema }), asyncHandler(ctrl.getMy));

// ─── Correction-request routes (must precede /:id) ───────────────────────

router.post('/correction-requests', validate({ body: submitCorrectionBodySchema }), asyncHandler(ctrl.postCorrection));

router.get('/correction-requests', validate({ query: listCorrectionsQuerySchema }), asyncHandler(ctrl.getCorrections));

router.post(
    '/correction-requests/:id/approve',
    authorize(...ATTENDANCE_REVIEW_ROLES),
    validate({ params: correctionRequestIdParamSchema, body: reviewCorrectionBodySchema }),
    asyncHandler(ctrl.postApproveCorrection)
);

router.post(
    '/correction-requests/:id/reject',
    authorize(...ATTENDANCE_REVIEW_ROLES),
    validate({ params: correctionRequestIdParamSchema, body: reviewCorrectionBodySchema }),
    asyncHandler(ctrl.postRejectCorrection)
);

// ─── Manager / admin record routes ───────────────────────────────────────

router.get(
    '/',
    authorize(...ATTENDANCE_REVIEW_ROLES),
    validate({ query: listAttendanceQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.patch(
    '/:id',
    authorize(...ATTENDANCE_REVIEW_ROLES),
    validate({ params: attendanceIdParamSchema, body: patchAttendanceBodySchema }),
    asyncHandler(ctrl.patchOne)
);

export default router;

import { Router } from 'express';

import * as ctrl from '../controllers/attendance.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
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
// All routes require `attendance.check_in_out` (employees + above);
// Clients don't hold this permission, mirroring legacy ATTENDANCE_INTERNAL_ROLES.
router.use(authenticate, requirePermission(PERMISSIONS.ATTENDANCE_CHECK_IN_OUT));

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
    requirePermission(PERMISSIONS.ATTENDANCE_CORRECTION_APPROVE),
    validate({ params: correctionRequestIdParamSchema, body: reviewCorrectionBodySchema }),
    asyncHandler(ctrl.postApproveCorrection)
);

router.post(
    '/correction-requests/:id/reject',
    requirePermission(PERMISSIONS.ATTENDANCE_CORRECTION_APPROVE),
    validate({ params: correctionRequestIdParamSchema, body: reviewCorrectionBodySchema }),
    asyncHandler(ctrl.postRejectCorrection)
);

// ─── Manager / admin record routes ───────────────────────────────────────

router.get(
    '/',
    requirePermission(PERMISSIONS.ATTENDANCE_READ_TEAM),
    validate({ query: listAttendanceQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.ATTENDANCE_CORRECTION_APPROVE),
    validate({ params: attendanceIdParamSchema, body: patchAttendanceBodySchema }),
    asyncHandler(ctrl.patchOne)
);

export default router;

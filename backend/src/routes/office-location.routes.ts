import { Router } from 'express';

import * as ctrl from '../controllers/office-location.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    createOfficeLocationBodySchema,
    listOfficeLocationsQuerySchema,
    officeLocationIdParamSchema,
    patchOfficeLocationBodySchema,
} from '../validators/office-location.validator.js';

const router = Router();

// All endpoints under /office-locations require an access token. Per-route
// `requirePermission(...)` then narrows to `OFFICE_LOCATION_WRITE` (admin)
// for writes and `OFFICE_LOCATION_READ` (admin + manager) for reads.
router.use(authenticate);

// ─── Collection routes ─────────────────────────────────────────────────────

router.get(
    '/',
    requirePermission(PERMISSIONS.OFFICE_LOCATION_READ),
    validate({ query: listOfficeLocationsQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.OFFICE_LOCATION_WRITE),
    validate({ body: createOfficeLocationBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// ─── Item routes — :id must come AFTER named collection paths ─────────────

router.get(
    '/:id',
    requirePermission(PERMISSIONS.OFFICE_LOCATION_READ),
    validate({ params: officeLocationIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.OFFICE_LOCATION_WRITE),
    validate({ params: officeLocationIdParamSchema, body: patchOfficeLocationBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.OFFICE_LOCATION_WRITE),
    validate({ params: officeLocationIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

router.post(
    '/:id/regenerate-qr',
    requirePermission(PERMISSIONS.OFFICE_LOCATION_WRITE),
    validate({ params: officeLocationIdParamSchema }),
    asyncHandler(ctrl.postRegenerateQr)
);

export default router;

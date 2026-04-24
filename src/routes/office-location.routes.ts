import { Router } from 'express';

import * as ctrl from '../controllers/office-location.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { OFFICE_LOCATION_READ_ROLES, OFFICE_LOCATION_WRITE_ROLES } from '../constants/office-location.js';
import {
    createOfficeLocationBodySchema,
    listOfficeLocationsQuerySchema,
    officeLocationIdParamSchema,
    patchOfficeLocationBodySchema,
} from '../validators/office-location.validator.js';

const router = Router();

// All endpoints under /office-locations require an access token. Per-route
// `authorize(...)` then narrows to ADM (writes) or ADM/MGR (reads).
router.use(authenticate);

// ─── Collection routes ─────────────────────────────────────────────────────

router.get(
    '/',
    authorize(...OFFICE_LOCATION_READ_ROLES),
    validate({ query: listOfficeLocationsQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    authorize(...OFFICE_LOCATION_WRITE_ROLES),
    validate({ body: createOfficeLocationBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// ─── Item routes — :id must come AFTER named collection paths ─────────────

router.get(
    '/:id',
    authorize(...OFFICE_LOCATION_READ_ROLES),
    validate({ params: officeLocationIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    authorize(...OFFICE_LOCATION_WRITE_ROLES),
    validate({ params: officeLocationIdParamSchema, body: patchOfficeLocationBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    authorize(...OFFICE_LOCATION_WRITE_ROLES),
    validate({ params: officeLocationIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

router.post(
    '/:id/regenerate-qr',
    authorize(...OFFICE_LOCATION_WRITE_ROLES),
    validate({ params: officeLocationIdParamSchema }),
    asyncHandler(ctrl.postRegenerateQr)
);

export default router;

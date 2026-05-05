import { Router } from 'express';

import * as ctrl from '../controllers/holiday.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    bulkCreateHolidaysBodySchema,
    createHolidayBodySchema,
    holidayIdParamSchema,
    listHolidaysQuerySchema,
    patchHolidayBodySchema,
} from '../validators/holiday.validator.js';

const router = Router();

router.use(authenticate);

// ─── Collection routes ─────────────────────────────────────────────────────

router.get(
    '/',
    requirePermission(PERMISSIONS.HOLIDAY_READ),
    validate({ query: listHolidaysQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.HOLIDAY_WRITE),
    validate({ body: createHolidayBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// `/bulk` MUST be declared before the `/:id` patterns so Express doesn't try
// to parse the literal string "bulk" as an ObjectId.
router.post(
    '/bulk',
    requirePermission(PERMISSIONS.HOLIDAY_WRITE),
    validate({ body: bulkCreateHolidaysBodySchema }),
    asyncHandler(ctrl.postBulk)
);

// ─── Item routes ──────────────────────────────────────────────────────────

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.HOLIDAY_WRITE),
    validate({ params: holidayIdParamSchema, body: patchHolidayBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.HOLIDAY_WRITE),
    validate({ params: holidayIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

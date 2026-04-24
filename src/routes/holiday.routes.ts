import { Router } from 'express';

import * as ctrl from '../controllers/holiday.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { HOLIDAY_READ_ROLES, HOLIDAY_WRITE_ROLES } from '../constants/holiday.js';
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
    authorize(...HOLIDAY_READ_ROLES),
    validate({ query: listHolidaysQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    authorize(...HOLIDAY_WRITE_ROLES),
    validate({ body: createHolidayBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// `/bulk` MUST be declared before the `/:id` patterns so Express doesn't try
// to parse the literal string "bulk" as an ObjectId.
router.post(
    '/bulk',
    authorize(...HOLIDAY_WRITE_ROLES),
    validate({ body: bulkCreateHolidaysBodySchema }),
    asyncHandler(ctrl.postBulk)
);

// ─── Item routes ──────────────────────────────────────────────────────────

router.patch(
    '/:id',
    authorize(...HOLIDAY_WRITE_ROLES),
    validate({ params: holidayIdParamSchema, body: patchHolidayBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    authorize(...HOLIDAY_WRITE_ROLES),
    validate({ params: holidayIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

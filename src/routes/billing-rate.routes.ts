import { Router } from 'express';

import * as ctrl from '../controllers/billing-rate.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { BILLING_RATE_READ_ROLES, BILLING_RATE_WRITE_ROLES } from '../constants/timesheet.js';
import {
    billingRateIdPathSchema,
    createBillingRateBodySchema,
    listBillingRatesQuerySchema,
    patchBillingRateBodySchema,
} from '../validators/billing-rate.validator.js';

/**
 * Billing-rate routes (Step 23; API_Contract.md §9.5).
 *
 * Read = manager + admin. Write = admin only. Per-row authorisation is
 * route-level (no per-row override), so the standard `authorize()`
 * middleware is sufficient.
 */
const router = Router();

router.use(authenticate);

router.get(
    '/',
    authorize(...BILLING_RATE_READ_ROLES),
    validate({ query: listBillingRatesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    authorize(...BILLING_RATE_WRITE_ROLES),
    validate({ body: createBillingRateBodySchema }),
    asyncHandler(ctrl.postCreate)
);

router.patch(
    '/:id',
    authorize(...BILLING_RATE_WRITE_ROLES),
    validate({ params: billingRateIdPathSchema, body: patchBillingRateBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.post(
    '/:id/end',
    authorize(...BILLING_RATE_WRITE_ROLES),
    validate({ params: billingRateIdPathSchema }),
    asyncHandler(ctrl.postEnd)
);

router.delete(
    '/:id',
    authorize(...BILLING_RATE_WRITE_ROLES),
    validate({ params: billingRateIdPathSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

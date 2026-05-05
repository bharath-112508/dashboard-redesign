import { Router } from 'express';

import * as ctrl from '../controllers/billing-rate.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    billingRateIdPathSchema,
    createBillingRateBodySchema,
    listBillingRatesQuerySchema,
    patchBillingRateBodySchema,
} from '../validators/billing-rate.validator.js';

/**
 * Billing-rate routes (Step 23; API_Contract.md §9.5).
 *
 * Read gated on `billing_rate.read` (manager + admin); write gated on
 * `billing_rate.write` (admin only). Per-row authorisation is purely
 * route-level (no per-row override), so the `requirePermission(...)`
 * gate is sufficient.
 */
const router = Router();

router.use(authenticate);

router.get(
    '/',
    requirePermission(PERMISSIONS.BILLING_RATE_READ),
    validate({ query: listBillingRatesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.BILLING_RATE_WRITE),
    validate({ body: createBillingRateBodySchema }),
    asyncHandler(ctrl.postCreate)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.BILLING_RATE_WRITE),
    validate({ params: billingRateIdPathSchema, body: patchBillingRateBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.post(
    '/:id/end',
    requirePermission(PERMISSIONS.BILLING_RATE_WRITE),
    validate({ params: billingRateIdPathSchema }),
    asyncHandler(ctrl.postEnd)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.BILLING_RATE_WRITE),
    validate({ params: billingRateIdPathSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

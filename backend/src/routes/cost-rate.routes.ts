import { Router } from 'express';

import * as ctrl from '../controllers/cost-rate.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    costRateIdPathSchema,
    createCostRateSchema,
    listCostRatesQuerySchema,
    updateCostRateSchema,
} from '../validators/cost-rate.validator.js';

/**
 * Cost-rate routes (Billing Phase 2 — Cost Rates & Margin, Task 3).
 *
 * Cost-side twin of `billing-rate.routes.ts`. Read gated on
 * `cost_rate.read`; write gated on `cost_rate.write`. Per-row
 * authorisation is purely route-level (no per-row override), so the
 * `requirePermission(...)` gate is sufficient.
 */
const router = Router();

router.use(authenticate);

router.get(
    '/',
    requirePermission(PERMISSIONS.COST_RATE_READ),
    validate({ query: listCostRatesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.COST_RATE_WRITE),
    validate({ body: createCostRateSchema }),
    asyncHandler(ctrl.postCreate)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.COST_RATE_WRITE),
    validate({ params: costRateIdPathSchema, body: updateCostRateSchema }),
    asyncHandler(ctrl.patchOne)
);

router.post(
    '/:id/end',
    requirePermission(PERMISSIONS.COST_RATE_WRITE),
    validate({ params: costRateIdPathSchema }),
    asyncHandler(ctrl.postEnd)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.COST_RATE_WRITE),
    validate({ params: costRateIdPathSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

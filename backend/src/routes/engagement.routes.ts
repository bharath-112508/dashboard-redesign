import { Router } from 'express';

import * as ctrl from '../controllers/engagement.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    createEngagementSchema,
    engagementIdPathSchema,
    listEngagementsQuerySchema,
    updateEngagementSchema,
} from '../validators/engagement.validator.js';

/**
 * Client-engagement routes (Phase 1 "Client Engagements & Invoicing", Task 4).
 *
 * Read gated on `invoice.read`; write gated on `invoice.write` — mirrors the
 * billing-rate router's shape. Per-row authorisation is purely route-level
 * (no per-row override), so `requirePermission(...)` alone is sufficient.
 */
const router = Router();

router.use(authenticate);

router.get(
    '/',
    requirePermission(PERMISSIONS.INVOICE_READ),
    validate({ query: listEngagementsQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.get(
    '/:id',
    requirePermission(PERMISSIONS.INVOICE_READ),
    validate({ params: engagementIdPathSchema }),
    asyncHandler(ctrl.getOne)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.INVOICE_WRITE),
    validate({ body: createEngagementSchema }),
    asyncHandler(ctrl.postCreate)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.INVOICE_WRITE),
    validate({ params: engagementIdPathSchema, body: updateEngagementSchema }),
    asyncHandler(ctrl.patchOne)
);

router.post(
    '/:id/end',
    requirePermission(PERMISSIONS.INVOICE_WRITE),
    validate({ params: engagementIdPathSchema }),
    asyncHandler(ctrl.postEnd)
);

export default router;

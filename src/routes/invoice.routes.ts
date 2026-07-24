import { Router } from 'express';

import * as ctrl from '../controllers/invoice.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    generateInvoiceSchema,
    invoiceIdPathSchema,
    invoiceStatusSchema,
    listInvoicesQuerySchema,
    updateInvoiceSchema,
} from '../validators/invoice.validator.js';

/**
 * Invoice routes (Phase 1 "Client Engagements & Invoicing", Task 8).
 *
 * Read gated on `invoice.read`; write gated on `invoice.write` — same shape
 * as `engagement.routes.ts` / `billing-rate.routes.ts`. Per-row
 * authorisation is purely route-level (no per-row override), so
 * `requirePermission(...)` alone is sufficient.
 *
 * `POST /:id/status` mounted BEFORE `GET /:id` doesn't matter here (distinct
 * methods/paths never collide), but the router still lists `generate`
 * before the `:id` routes so the literal `/generate` segment can never be
 * shadowed by a param match — Express matches path literals over params in
 * registration order per-method, so this is defence-in-depth, not a fix.
 */
const router = Router();

router.use(authenticate);

router.get(
    '/',
    requirePermission(PERMISSIONS.INVOICE_READ),
    validate({ query: listInvoicesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/generate',
    requirePermission(PERMISSIONS.INVOICE_WRITE),
    validate({ body: generateInvoiceSchema }),
    asyncHandler(ctrl.postGenerate)
);

router.get(
    '/:id',
    requirePermission(PERMISSIONS.INVOICE_READ),
    validate({ params: invoiceIdPathSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.INVOICE_WRITE),
    validate({ params: invoiceIdPathSchema, body: updateInvoiceSchema }),
    asyncHandler(ctrl.patchOne)
);

router.post(
    '/:id/status',
    requirePermission(PERMISSIONS.INVOICE_WRITE),
    validate({ params: invoiceIdPathSchema, body: invoiceStatusSchema }),
    asyncHandler(ctrl.postStatus)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.INVOICE_WRITE),
    validate({ params: invoiceIdPathSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

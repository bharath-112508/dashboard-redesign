import { Router } from 'express';

import * as ctrl from '../controllers/payslip.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    generatePayslipBodySchema,
    listPayslipsQuerySchema,
    payslipIdPathSchema,
} from '../validators/payslip.validator.js';

/**
 * Payslip routes (Task 7). Generation + download share `payslip.generate`
 * (the act of pulling a payslip PDF, whether freshly rendered or a repeat
 * download, is gated the same way); list is gated on the broader
 * `payroll.read` so read-only payroll reviewers can see what's been
 * generated without being able to trigger a new render/download.
 */
const router = Router();
router.use(authenticate);

router.post(
    '/',
    requirePermission(PERMISSIONS.PAYSLIP_GENERATE),
    validate({ body: generatePayslipBodySchema }),
    asyncHandler(ctrl.postGenerate)
);

// Preview renders the exact same PDF as generate but stores nothing (no
// blob, no Payslip row, no audit row) — placed before `/:id/download` so it
// isn't shadowed by any future param-based route.
router.post(
    '/preview',
    requirePermission(PERMISSIONS.PAYSLIP_GENERATE),
    validate({ body: generatePayslipBodySchema }),
    asyncHandler(ctrl.postPreview)
);

// HTML preview for the live on-page editor (no Playwright, no persistence).
router.post(
    '/preview-html',
    requirePermission(PERMISSIONS.PAYSLIP_GENERATE),
    validate({ body: generatePayslipBodySchema }),
    asyncHandler(ctrl.postPreviewHtml)
);

router.get(
    '/',
    requirePermission(PERMISSIONS.PAYROLL_READ),
    validate({ query: listPayslipsQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.get(
    '/:id/download',
    requirePermission(PERMISSIONS.PAYSLIP_GENERATE),
    validate({ params: payslipIdPathSchema }),
    asyncHandler(ctrl.getDownload)
);

export default router;

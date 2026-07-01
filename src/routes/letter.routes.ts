import { Router } from 'express';

import * as ctrl from '../controllers/letter.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    generateLetterBodySchema,
    listLettersQuerySchema,
    letterIdPathSchema,
} from '../validators/letter.validator.js';

/**
 * Letter routes (Task 8). Generation + download share `letter.generate`
 * (same rationale as payslip.routes.ts — pulling a letter PDF, whether
 * freshly rendered or a repeat download, is the sensitive act); list is
 * gated on the broader `payroll.read` so read-only payroll reviewers can
 * see what's been generated without being able to trigger a new
 * render/download.
 */
const router = Router();
router.use(authenticate);

router.post(
    '/',
    requirePermission(PERMISSIONS.LETTER_GENERATE),
    validate({ body: generateLetterBodySchema }),
    asyncHandler(ctrl.postGenerate)
);

router.get(
    '/',
    requirePermission(PERMISSIONS.PAYROLL_READ),
    validate({ query: listLettersQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.get(
    '/:id/download',
    requirePermission(PERMISSIONS.LETTER_GENERATE),
    validate({ params: letterIdPathSchema }),
    asyncHandler(ctrl.getDownload)
);

export default router;

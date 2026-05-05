import { Router } from 'express';

import * as ctrl from '../controllers/report-preset.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    createReportPresetBodySchema,
    listReportPresetsQuerySchema,
    patchReportPresetBodySchema,
    reportPresetIdParamSchema,
} from '../validators/report-preset.validator.js';

/**
 * Report-preset routes (Phase 4 Step 42).
 *
 * Owner-scoped CRUD. Role gate is admin/manager (mirrors Step-29
 * report-read roles); per-row owner scoping happens inside the
 * service. The 404 → not 403 mapping on cross-user access is
 * deliberate — anti-enumeration matches the notification + session
 * patterns.
 */
const router = Router();

router.use(authenticate);
router.use(requirePermission(PERMISSIONS.REPORT_READ));

router.get('/', validate({ query: listReportPresetsQuerySchema }), asyncHandler(ctrl.getList));
router.post('/', validate({ body: createReportPresetBodySchema }), asyncHandler(ctrl.postCreate));
router.get('/:id', validate({ params: reportPresetIdParamSchema }), asyncHandler(ctrl.getOne));
router.patch(
    '/:id',
    validate({ params: reportPresetIdParamSchema, body: patchReportPresetBodySchema }),
    asyncHandler(ctrl.patchOne)
);
router.delete('/:id', validate({ params: reportPresetIdParamSchema }), asyncHandler(ctrl.deleteOne));

export default router;

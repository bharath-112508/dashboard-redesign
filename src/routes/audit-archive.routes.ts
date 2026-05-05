import { Router } from 'express';

import * as ctrl from '../controllers/audit-archive.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { AUDIT_ARCHIVE_READ_ROLES } from '../constants/audit-archive.js';
import { auditArchiveIdParamSchema, listAuditArchivesQuerySchema } from '../validators/audit-archive.validator.js';

/**
 * Audit-archive routes (Phase 4 Step 39).
 *
 * Read-only, admin-only. Writes happen from the daily archival cron
 * — there is no public POST/PATCH/DELETE.
 */
const router = Router();

router.use(authenticate);
router.use(authorize(...AUDIT_ARCHIVE_READ_ROLES));

router.get('/', validate({ query: listAuditArchivesQuerySchema }), asyncHandler(ctrl.getList));
router.get('/:id', validate({ params: auditArchiveIdParamSchema }), asyncHandler(ctrl.getOne));
router.get('/:id/verify', validate({ params: auditArchiveIdParamSchema }), asyncHandler(ctrl.getVerify));

export default router;

import { Router } from 'express';

import * as ctrl from '../controllers/audit-log.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { AUDIT_LOG_READ_ROLES } from '../constants/audit.js';
import { auditLogIdParamSchema, listAuditLogsQuerySchema } from '../validators/audit-log.validator.js';

/**
 * Audit-log routes (Step 31; API_Contract §12).
 *
 * Read-only, admin-only. Writes happen from inside business services
 * via `audit.service.recordAudit` — there is no public POST/PATCH/DELETE.
 */
const router = Router();

router.use(authenticate);
router.use(authorize(...AUDIT_LOG_READ_ROLES));

router.get('/', validate({ query: listAuditLogsQuerySchema }), asyncHandler(ctrl.getList));
router.get('/:id', validate({ params: auditLogIdParamSchema }), asyncHandler(ctrl.getOne));

export default router;

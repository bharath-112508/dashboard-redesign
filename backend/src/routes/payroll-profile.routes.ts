import { Router } from 'express';

import * as ctrl from '../controllers/payroll-profile.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    upsertPayrollProfileBodySchema,
    listPayrollProfilesQuerySchema,
    payrollUserIdPathSchema,
} from '../validators/payroll-profile.validator.js';

/**
 * PayrollProfile routes. Read gated on `payroll.read`, write gated on
 * `payroll.write`.
 */
const router = Router();
router.use(authenticate);

router.get(
    '/',
    requirePermission(PERMISSIONS.PAYROLL_READ),
    validate({ query: listPayrollProfilesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.get(
    '/:user_id',
    requirePermission(PERMISSIONS.PAYROLL_READ),
    validate({ params: payrollUserIdPathSchema }),
    asyncHandler(ctrl.getOne)
);

router.put(
    '/:user_id',
    requirePermission(PERMISSIONS.PAYROLL_WRITE),
    validate({ params: payrollUserIdPathSchema, body: upsertPayrollProfileBodySchema }),
    asyncHandler(ctrl.putUpsert)
);

export default router;

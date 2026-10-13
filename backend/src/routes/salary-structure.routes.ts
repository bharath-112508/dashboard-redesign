import { Router } from 'express';

import * as ctrl from '../controllers/salary-structure.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    createSalaryStructureBodySchema,
    listSalaryStructuresQuerySchema,
    salaryStructureIdPathSchema,
} from '../validators/salary-structure.validator.js';

/**
 * SalaryStructure routes (Task 5). Read gated on `payroll.read`, write
 * gated on `payroll.write` — same permission pair as `/payroll-profiles`.
 */
const router = Router();
router.use(authenticate);

router.get(
    '/',
    requirePermission(PERMISSIONS.PAYROLL_READ),
    validate({ query: listSalaryStructuresQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.PAYROLL_WRITE),
    validate({ body: createSalaryStructureBodySchema }),
    asyncHandler(ctrl.postCreate)
);

router.get(
    '/:id',
    requirePermission(PERMISSIONS.PAYROLL_READ),
    validate({ params: salaryStructureIdPathSchema }),
    asyncHandler(ctrl.getOne)
);

export default router;

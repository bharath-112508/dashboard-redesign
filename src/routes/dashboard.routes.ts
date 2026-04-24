import { Router } from 'express';

import * as ctrl from '../controllers/dashboard.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { DASHBOARD_ADMIN_ROLES, DASHBOARD_EMPLOYEE_ROLES, DASHBOARD_MANAGER_ROLES } from '../constants/dashboard.js';

/**
 * Dashboard routes (API_Contract.md §14, Step 13).
 *
 * Phase 1 ships admin/manager/employee. The `/dashboard/client` surface is
 * intentionally deferred until the projects module lands in Phase 2 — there
 * is no project data to summarise for clients yet, so a stub endpoint would
 * just return an empty payload. Adding it later is a route-level edit.
 */

const router = Router();
router.use(authenticate);

router.get('/admin', authorize(...DASHBOARD_ADMIN_ROLES), asyncHandler(ctrl.getAdmin));
router.get('/manager', authorize(...DASHBOARD_MANAGER_ROLES), asyncHandler(ctrl.getManager));
router.get('/employee', authorize(...DASHBOARD_EMPLOYEE_ROLES), asyncHandler(ctrl.getEmployee));

export default router;

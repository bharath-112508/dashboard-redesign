import { Router } from 'express';

import * as ctrl from '../controllers/dashboard.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';

/**
 * Dashboard routes (API_Contract.md §14, Step 13).
 *
 * Three surfaces shipped: admin / manager / employee. The
 * `/dashboard/client` surface is **not yet implemented** — clients
 * see project data via `GET /projects` filtered to their `client_ids`,
 * which is what the FE currently renders for them. Adding the
 * dedicated dashboard is a route-level addition (1 controller + 1
 * service helper) when the FE has a real client landing-page design.
 */

const router = Router();
router.use(authenticate);

router.get('/admin', requirePermission(PERMISSIONS.DASHBOARD_ADMIN), asyncHandler(ctrl.getAdmin));
router.get('/manager', requirePermission(PERMISSIONS.DASHBOARD_MANAGER), asyncHandler(ctrl.getManager));
router.get('/employee', requirePermission(PERMISSIONS.DASHBOARD_EMPLOYEE), asyncHandler(ctrl.getEmployee));

export default router;

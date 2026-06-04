import { Router } from 'express';

import * as ctrl from '../controllers/dashboard.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';

/**
 * Dashboard routes (API_Contract.md §14, Step 13).
 *
 * Four surfaces shipped: admin / manager / employee / client. Each
 * route is gated by its matching `dashboard.*` permission so a
 * caller with multiple role bundles only ever hits one endpoint per
 * navigation. Per-row visibility (e.g. a client only seeing the
 * projects they're on) is enforced at the service layer.
 */

const router = Router();
router.use(authenticate);

router.get('/admin', requirePermission(PERMISSIONS.DASHBOARD_ADMIN), asyncHandler(ctrl.getAdmin));
router.get('/manager', requirePermission(PERMISSIONS.DASHBOARD_MANAGER), asyncHandler(ctrl.getManager));
router.get('/employee', requirePermission(PERMISSIONS.DASHBOARD_EMPLOYEE), asyncHandler(ctrl.getEmployee));
router.get('/client', requirePermission(PERMISSIONS.DASHBOARD_CLIENT), asyncHandler(ctrl.getClient));

export default router;

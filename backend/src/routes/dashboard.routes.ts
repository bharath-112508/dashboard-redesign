import { Router } from 'express';

import * as ctrl from '../controllers/dashboard.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { dashboardAnalyticsQuerySchema, dashboardOverviewQuerySchema } from '../validators/dashboard.validator.js';

/**
 * Dashboard routes (API_Contract.md §14, Step 13).
 *
 * Four surfaces shipped: admin / manager / employee / client. Each
 * route is gated by its matching `dashboard.*` permission so a
 * caller with multiple role bundles only ever hits one endpoint per
 * navigation. Per-row visibility (e.g. a client only seeing the
 * projects they're on) is enforced at the service layer.
 *
 * Analytics routes (Task 8): four `/analytics` sub-routes mirror
 * the snapshot routes but accept a `?range=` query parameter and
 * return time-windowed section data. The `validate` middleware applies
 * the range schema and writes the coerced default ('month') back onto
 * `req.query` before the controller reads it.
 *
 * Overview routes (range-aware dashboard rework, Task 4): four
 * `/overview` sub-routes accept `?from=&to=` (both `YYYY-MM-DD`,
 * defaulted to the current month, validated `from <= to` and span
 * <= 366 days by `dashboardOverviewQuerySchema`) and return the
 * 3-summary-card + attendance/representatives/projects payload built
 * by `services/dashboard-overview.service.ts`.
 */

const router = Router();
router.use(authenticate);

const analyticsQuery = validate({ query: dashboardAnalyticsQuerySchema });
const overviewQuery = validate({ query: dashboardOverviewQuerySchema });

// Snapshot routes
router.get('/admin', requirePermission(PERMISSIONS.DASHBOARD_ADMIN), asyncHandler(ctrl.getAdmin));
router.get('/manager', requirePermission(PERMISSIONS.DASHBOARD_MANAGER), asyncHandler(ctrl.getManager));
router.get('/employee', requirePermission(PERMISSIONS.DASHBOARD_EMPLOYEE), asyncHandler(ctrl.getEmployee));
router.get('/client', requirePermission(PERMISSIONS.DASHBOARD_CLIENT), asyncHandler(ctrl.getClient));

// Analytics routes — must come before the bare /:scope pattern if one were
// added in the future; Express matches these specific paths first regardless
// of declaration order, but we place them after snapshot routes for clarity.
router.get(
    '/admin/analytics',
    requirePermission(PERMISSIONS.DASHBOARD_ADMIN),
    analyticsQuery,
    asyncHandler(ctrl.getAdminAnalytics)
);
router.get(
    '/manager/analytics',
    requirePermission(PERMISSIONS.DASHBOARD_MANAGER),
    analyticsQuery,
    asyncHandler(ctrl.getManagerAnalytics)
);
router.get(
    '/employee/analytics',
    requirePermission(PERMISSIONS.DASHBOARD_EMPLOYEE),
    analyticsQuery,
    asyncHandler(ctrl.getEmployeeAnalytics)
);
router.get(
    '/client/analytics',
    requirePermission(PERMISSIONS.DASHBOARD_CLIENT),
    analyticsQuery,
    asyncHandler(ctrl.getClientAnalytics)
);

// Overview routes (Task 4) — range-aware, `?from=&to=`.
router.get(
    '/admin/overview',
    requirePermission(PERMISSIONS.DASHBOARD_ADMIN),
    overviewQuery,
    asyncHandler(ctrl.getAdminOverview)
);
router.get(
    '/manager/overview',
    requirePermission(PERMISSIONS.DASHBOARD_MANAGER),
    overviewQuery,
    asyncHandler(ctrl.getManagerOverview)
);
router.get(
    '/employee/overview',
    requirePermission(PERMISSIONS.DASHBOARD_EMPLOYEE),
    overviewQuery,
    asyncHandler(ctrl.getEmployeeOverview)
);
router.get(
    '/client/overview',
    requirePermission(PERMISSIONS.DASHBOARD_CLIENT),
    overviewQuery,
    asyncHandler(ctrl.getClientOverview)
);

export default router;

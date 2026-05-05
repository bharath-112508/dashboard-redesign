import { Router } from 'express';

import * as ctrl from '../controllers/report.controller.js';
import * as exportCtrl from '../controllers/report-export.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { exportRateLimiter, reportReadRateLimiter } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    attendanceReportQuerySchema,
    billingReportQuerySchema,
    leaveReportQuerySchema,
    utilizationReportQuerySchema,
} from '../validators/report.validator.js';
import { exportIdPathSchema, exportRequestPathSchema } from '../validators/report-export.validator.js';

/**
 * Report routes (Step 29 reads + Step 30 exports; API_Contract §10).
 *
 * Reads (GETs) and exports (POST + status-poll GET) are both read-only
 * gated to manager + admin. Reports cross user boundaries by design
 * (billing rolls up by project, utilization spans the team) so
 * employees and clients have no row-level filter that would make the
 * surface safe — the route gate is an unconditional deny for those
 * roles.
 *
 * Route ordering note: the static `/exports/:id` route is mounted
 * BEFORE `/:name/export` because Express matches in registration
 * order. This is also a defence-in-depth: the static segment
 * `exports` is not a member of `REPORT_EXPORT_NAMES` (the validator
 * enum is `{billing, utilization, attendance, leaves}`) so a stray
 * `POST /reports/exports/...` would be rejected by the validator
 * anyway, but the explicit ordering avoids relying on that.
 */
const router = Router();

router.use(authenticate);
router.use(requirePermission(PERMISSIONS.REPORT_READ));

// ─── Synchronous JSON reads (Step 29) ───────────────────────────────────
// Per-user limiter (BACKEND_AUDIT.md P2-9): 60 reads / minute / user.
// Stacked on top of the global per-IP cap so a corporate-NAT cohort
// doesn't share one bucket. The router-level `.use` binds it to every
// GET below this line.
router.use(reportReadRateLimiter);
router.get('/billing', validate({ query: billingReportQuerySchema }), asyncHandler(ctrl.getBilling));
router.get('/utilization', validate({ query: utilizationReportQuerySchema }), asyncHandler(ctrl.getUtilization));
router.get('/attendance', validate({ query: attendanceReportQuerySchema }), asyncHandler(ctrl.getAttendance));
router.get('/leaves', validate({ query: leaveReportQuerySchema }), asyncHandler(ctrl.getLeaves));

// ─── Async exports (Step 30) ────────────────────────────────────────────
//
// The export-status endpoint sits at `/reports/exports/:id` rather than
// the contract's example `/exports/:id` — keeping the surface contiguous
// under `/reports/*` so a future operator browsing the route table sees
// the export poll next to the synchronous endpoints it consumes.
//
// Per-controller `parseExportBody` does the body validation (it has to
// dispatch on `:name` to pick the per-report filter schema) so we don't
// thread a `validate({body})` middleware here for the POST.
router.get(
    '/exports/:id',
    requirePermission(PERMISSIONS.REPORT_EXPORT_WRITE),
    validate({ params: exportIdPathSchema }),
    asyncHandler(exportCtrl.getExportStatus)
);
router.post(
    '/:name/export',
    // Per-user export limiter (P2-9): 10 exports / 15 min / user. The
    // export worker spins up a PDF / XLSX render in the background; a
    // tight loop here would back-pressure the worker for everyone. Lower
    // ceiling than the read limiter to match the higher per-call cost.
    exportRateLimiter,
    requirePermission(PERMISSIONS.REPORT_EXPORT_WRITE),
    validate({ params: exportRequestPathSchema }),
    asyncHandler(exportCtrl.postExport)
);

export default router;

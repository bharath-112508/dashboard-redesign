import { Router } from 'express';

import * as ctrl from '../controllers/report.controller.js';
import * as exportCtrl from '../controllers/report-export.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { requireBillingModules, requireExportableReport } from '../middlewares/feature-flag.middleware.js';
import { exportRateLimiter, reportReadRateLimiter } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    attendanceReportQuerySchema,
    billingReportQuerySchema,
    leaveReportQuerySchema,
    marginReportQuerySchema,
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

// ─── GET /reports/margin (Billing Phase 2, Task 5) ──────────────────────
//
// Gated on `COST_RATE_READ`, NOT the blanket `REPORT_READ` applied to
// every other route below via `router.use(...)` — seeing margin means
// seeing cost, which is more sensitive than the other reports. This
// route is registered BEFORE that blanket `.use()` so Express never
// stacks the `REPORT_READ` check on top of it: a custom role holding
// ONLY `cost_rate.read` (no `report.read`) can still reach this
// endpoint. Manager holds both by default (system-role-definitions.ts),
// so this reordering is invisible to the out-of-the-box roles. Uses the
// same per-user read limiter as the other sync reports below (applied
// per-route here since it would otherwise only be `.use()`'d after the
// blanket gate).
router.get(
    '/margin',
    // Out of scope for the current phase — 404s unless BILLING_MODULES_ENABLED.
    requireBillingModules,
    reportReadRateLimiter,
    requirePermission(PERMISSIONS.COST_RATE_READ),
    validate({ query: marginReportQuerySchema }),
    asyncHandler(ctrl.getMargin)
);

router.use(requirePermission(PERMISSIONS.REPORT_READ));

// ─── Synchronous JSON reads (Step 29) ───────────────────────────────────
// Per-user limiter (BACKEND_AUDIT.md P2-9): 60 reads / minute / user.
// Stacked on top of the global per-IP cap so a corporate-NAT cohort
// doesn't share one bucket. The router-level `.use` binds it to every
// GET below this line.
router.use(reportReadRateLimiter);
// Same gate as /margin: billing is a money surface, out of scope this phase.
router.get(
    '/billing',
    requireBillingModules,
    validate({ query: billingReportQuerySchema }),
    asyncHandler(ctrl.getBilling)
);
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
    // An export renders the same builder as the sync GET, so a gated report
    // must be unavailable in both shapes or the file is a way around it.
    requireExportableReport,
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

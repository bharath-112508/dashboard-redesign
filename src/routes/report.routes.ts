import { Router } from 'express';

import * as ctrl from '../controllers/report.controller.js';
import * as exportCtrl from '../controllers/report-export.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { REPORT_READ_ROLES } from '../constants/report.js';
import { REPORT_EXPORT_ROLES } from '../constants/export.js';
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
router.use(authorize(...REPORT_READ_ROLES));

// ─── Synchronous JSON reads (Step 29) ───────────────────────────────────
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
    authorize(...REPORT_EXPORT_ROLES),
    validate({ params: exportIdPathSchema }),
    asyncHandler(exportCtrl.getExportStatus)
);
router.post(
    '/:name/export',
    authorize(...REPORT_EXPORT_ROLES),
    validate({ params: exportRequestPathSchema }),
    asyncHandler(exportCtrl.postExport)
);

export default router;

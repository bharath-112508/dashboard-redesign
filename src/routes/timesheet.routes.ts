import { Router } from 'express';

import * as ctrl from '../controllers/timesheet.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    createTimesheetBodySchema,
    dayDatePathSchema,
    listTimesheetsQuerySchema,
    patchTimesheetBodySchema,
    summaryQuerySchema,
    timesheetIdPathSchema,
} from '../validators/timesheet.validator.js';

/**
 * Timesheet routes (Step 23; API_Contract.md §9.1–9.4).
 *
 * Order matters: the literal-segment routes (`/me`, `/me/day/:date`,
 * `/summary`) must be declared BEFORE `/:id` so Express doesn't match
 * `me`, `summary`, etc. as ObjectId path params.
 */
const router = Router();

router.use(authenticate);

// ─── /me — own entries ──────────────────────────────────────────────────
//
// M4 — these were gated on `TIMESHEET_WRITE`, which excluded read-only
// audit/HR holders of `TIMESHEET_READ`. The service `listMyEntries` /
// `listMyDay` already pin the filter to the caller's `user_id`, so
// authenticate-only is the correct policy: any authenticated user can
// list their own entries (Employee, Team Lead, Manager, Admin all do).

router.get('/me', validate({ query: listTimesheetsQuerySchema }), asyncHandler(ctrl.getMyList));

router.get('/me/day/:date', validate({ params: dayDatePathSchema }), asyncHandler(ctrl.getMyDay));

// ─── /summary — manager + admin ─────────────────────────────────────────

router.get(
    '/summary',
    requirePermission(PERMISSIONS.TIMESHEET_READ),
    validate({ query: summaryQuerySchema }),
    asyncHandler(ctrl.getSummary)
);

// ─── /export — manager + admin ──────────────────────────────────────────

// MUST stay above `/:id` (see the file header): Express would otherwise
// match "export" as an ObjectId param and 400 on the cast.
//
// Same gate and the same service call as the list below, so the export can
// never widen what a caller is allowed to read.
router.get(
    '/export',
    requirePermission(PERMISSIONS.TIMESHEET_READ),
    validate({ query: listTimesheetsQuerySchema }),
    asyncHandler(ctrl.getExport)
);

// ─── Collection — manager + admin ───────────────────────────────────────

router.get(
    '/',
    requirePermission(PERMISSIONS.TIMESHEET_READ),
    validate({ query: listTimesheetsQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
    validate({ body: createTimesheetBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// ─── /:id — read-self-or-privileged; write enforced inside service ──────

// M4 — was gated on `TIMESHEET_WRITE` only, which excluded any
// read-only role holding `TIMESHEET_READ` (audit/HR). `requirePermission`
// uses anyOf semantics, so passing both lets either role pass the gate;
// the row-level self-or-privileged check inside `getEntry` is the
// actual authorization on the entry (entry owner OR manager/admin).
router.get(
    '/:id',
    requirePermission(PERMISSIONS.TIMESHEET_READ, PERMISSIONS.TIMESHEET_WRITE),
    validate({ params: timesheetIdPathSchema }),
    asyncHandler(ctrl.getById)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
    validate({ params: timesheetIdPathSchema, body: patchTimesheetBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
    validate({ params: timesheetIdPathSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

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

router.get(
    '/me',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
    validate({ query: listTimesheetsQuerySchema }),
    asyncHandler(ctrl.getMyList)
);

router.get(
    '/me/day/:date',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
    validate({ params: dayDatePathSchema }),
    asyncHandler(ctrl.getMyDay)
);

// ─── /summary — manager + admin ─────────────────────────────────────────

router.get(
    '/summary',
    requirePermission(PERMISSIONS.TIMESHEET_READ),
    validate({ query: summaryQuerySchema }),
    asyncHandler(ctrl.getSummary)
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

router.get(
    '/:id',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
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

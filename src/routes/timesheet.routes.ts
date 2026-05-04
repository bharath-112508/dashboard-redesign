import { Router } from 'express';

import * as ctrl from '../controllers/timesheet.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { TIMESHEET_MANAGER_ROLES, TIMESHEET_SELF_ROLES } from '../constants/timesheet.js';
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
    authorize(...TIMESHEET_SELF_ROLES),
    validate({ query: listTimesheetsQuerySchema }),
    asyncHandler(ctrl.getMyList)
);

router.get(
    '/me/day/:date',
    authorize(...TIMESHEET_SELF_ROLES),
    validate({ params: dayDatePathSchema }),
    asyncHandler(ctrl.getMyDay)
);

// ─── /summary — manager + admin ─────────────────────────────────────────

router.get(
    '/summary',
    authorize(...TIMESHEET_MANAGER_ROLES),
    validate({ query: summaryQuerySchema }),
    asyncHandler(ctrl.getSummary)
);

// ─── Collection — manager + admin ───────────────────────────────────────

router.get(
    '/',
    authorize(...TIMESHEET_MANAGER_ROLES),
    validate({ query: listTimesheetsQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    authorize(...TIMESHEET_SELF_ROLES),
    validate({ body: createTimesheetBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// ─── /:id — read-self-or-privileged; write enforced inside service ──────

router.get(
    '/:id',
    authorize(...TIMESHEET_SELF_ROLES),
    validate({ params: timesheetIdPathSchema }),
    asyncHandler(ctrl.getById)
);

router.patch(
    '/:id',
    authorize(...TIMESHEET_SELF_ROLES),
    validate({ params: timesheetIdPathSchema, body: patchTimesheetBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    authorize(...TIMESHEET_SELF_ROLES),
    validate({ params: timesheetIdPathSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

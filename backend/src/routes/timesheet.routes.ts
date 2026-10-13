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
    listWeeksQuerySchema,
    reopenWeekQuerySchema,
    weekPathSchema,
    patchTimesheetBodySchema,
    summaryQuerySchema,
    timesheetIdPathSchema,
    timesheetImportBodySchema,
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

// ─── /weeks — submitted weeks (redesign) ─────────────────────────────────
//
// Literal segment, so declared above `/:id`. Listing is open to everyone
// (the service pins a non-reviewer to their own weeks); submitting needs the
// write permission and is always the caller's own week; reopening someone
// else's week is checked in the service (manager or admin).

router.get('/weeks', validate({ query: listWeeksQuerySchema }), asyncHandler(ctrl.getWeeks));
router.put(
    '/weeks/:week',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
    validate({ params: weekPathSchema }),
    asyncHandler(ctrl.putWeek)
);
router.delete(
    '/weeks/:week',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
    validate({ params: weekPathSchema, query: reopenWeekQuerySchema }),
    asyncHandler(ctrl.deleteWeek)
);

// ─── /import — bulk import of YOUR OWN entries ──────────────────────────
//
// Declared above `/:id` for the same reason as `/me` and `/summary`: Express
// would otherwise try to cast the literal "import" to an ObjectId.
//
// Gated on `TIMESHEET_WRITE` — the same permission a single entry needs, and
// no more. The service pins every row to the caller (`user_id: caller.id`),
// so this cannot create time for anyone else no matter what the file says;
// there is deliberately no user column in the format.
//
// Preview writes nothing but is a POST, not a GET: the row set is a body, not
// something that belongs in a query string.

router.post(
    '/import/preview',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
    validate({ body: timesheetImportBodySchema }),
    asyncHandler(ctrl.postImportPreview)
);

router.post(
    '/import',
    requirePermission(PERMISSIONS.TIMESHEET_WRITE),
    validate({ body: timesheetImportBodySchema }),
    asyncHandler(ctrl.postImport)
);

router.get('/me/day/:date', validate({ params: dayDatePathSchema }), asyncHandler(ctrl.getMyDay));

// ─── /summary — manager + admin, plus a narrow client-side slice ────────

// `PROJECT_READ` is listed as an alternative (anyOf) so client-side callers,
// who hold no `timesheet.*` permission at all, can reach the billable-only
// project view. It does NOT widen the endpoint: `summary()` refuses any role
// that is neither client-side nor a team-timesheet reader, so an Employee —
// who also holds `project.read` — still gets a 403 from the service.
router.get(
    '/summary',
    requirePermission(PERMISSIONS.TIMESHEET_READ, PERMISSIONS.PROJECT_READ),
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

// ─── Collection — manager + admin, plus the client-side slice ───────────

// `PROJECT_READ` alternative for the same reason as `/summary` above: the
// client-side project view lists its billable rows through this endpoint, and
// `listAllEntries` is what actually decides who sees what.
router.get(
    '/',
    requirePermission(PERMISSIONS.TIMESHEET_READ, PERMISSIONS.PROJECT_READ),
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

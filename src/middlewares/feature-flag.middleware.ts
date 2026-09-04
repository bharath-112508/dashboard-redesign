import { Request, Response, NextFunction, RequestHandler } from 'express';

import { BILLING_MODULES_ENABLED, OFFICE_LOCATIONS_ENABLED } from '../config/server.config.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AppError } from '../utils/app-error.js';

/**
 * Route gates for surfaces that are built but deliberately not part of the
 * current phase.
 *
 * These are **not** authorization. `requirePermission` answers "may THIS
 * caller do it"; a feature gate answers "does this exist yet". The two are
 * layered, not alternatives — turning a flag on restores the ordinary
 * permission checks underneath, unchanged.
 */

/**
 * Guards the money surfaces — billing rates, cost rates, engagements,
 * invoices, and the Billing + Margin reports — behind
 * `BILLING_MODULES_ENABLED` (off by default; see `server.config.ts`).
 *
 * **404, not 403.** The resource genuinely does not exist in this
 * deployment, and 403 would tell an unauthenticated prober that an
 * invoices API is there and merely closed to them. It also matches the
 * frontend, which doesn't register these routes at all when its own flag
 * is off, so both halves answer a disabled surface the same way.
 *
 * Applied at the mount point rather than inside each router, so the mount
 * list in `routes/index.ts` still shows the module exists and is gated —
 * deleting those lines would hide the fact that there's anything to
 * re-enable.
 */
export const requireBillingModules: RequestHandler = (_req: Request, _res: Response, next: NextFunction) => {
    if (!BILLING_MODULES_ENABLED) {
        next(AppError.notFound('Not found', ERROR_CODES.RESOURCE_NOT_FOUND));
        return;
    }
    next();
};

/**
 * The async-export twin of the guard above.
 *
 * `POST /reports/:name/export` renders the SAME builder the synchronous
 * `GET /reports/:name` uses, so gating only the GET would have left the
 * billing figures reachable by asking for them as a file instead. The
 * report name is a URL segment rather than its own route, which is why
 * this has to inspect the param instead of being mounted per-path.
 */
const GATED_REPORT_NAMES: readonly string[] = ['billing'];

export const requireExportableReport: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    const name = typeof req.params.name === 'string' ? req.params.name : '';
    if (!BILLING_MODULES_ENABLED && GATED_REPORT_NAMES.includes(name)) {
        next(AppError.notFound('Not found', ERROR_CODES.RESOURCE_NOT_FOUND));
        return;
    }
    next();
};

/**
 * Guards the office-location directory behind `OFFICE_LOCATIONS_ENABLED`
 * (off by default; see `server.config.ts`).
 *
 * Same 404-not-403 reasoning as the billing gate. Scoped to the MANAGEMENT
 * routes only — attendance check-in is untouched, because geofence policy is
 * read from `SystemSettings.attendance.geofence` and QR verification resolves
 * its token straight off the model rather than through this router.
 */
export const requireOfficeLocations: RequestHandler = (_req: Request, _res: Response, next: NextFunction) => {
    if (!OFFICE_LOCATIONS_ENABLED) {
        next(AppError.notFound('Not found', ERROR_CODES.RESOURCE_NOT_FOUND));
        return;
    }
    next();
};

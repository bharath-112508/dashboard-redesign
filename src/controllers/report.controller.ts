import { Request, Response } from 'express';

import * as service from '../services/report.service.js';
import { ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type {
    AttendanceReportQuery,
    BillingReportQuery,
    LeaveReportQuery,
    UtilizationReportQuery,
} from '../validators/report.validator.js';

/**
 * Report controllers (Step 29; API_Contract §10).
 *
 * Each handler is a thin pass-through: validation has already coerced
 * the query to its typed shape and `authorize(...REPORT_READ_ROLES)` has
 * already gated to manager + admin. We still assert a caller is present
 * so a misconfigured route (auth middleware skipped by accident) fails
 * loudly with `401` rather than crashing inside the service layer.
 */

const ensureCaller = (req: Request): void => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
};

// ─── GET /reports/billing ────────────────────────────────────────────────

export const getBilling = async (req: Request, res: Response): Promise<Response> => {
    ensureCaller(req);
    const data = await service.buildBillingReport(req.query as unknown as BillingReportQuery);
    return ok(res, data);
};

// ─── GET /reports/utilization ────────────────────────────────────────────

export const getUtilization = async (req: Request, res: Response): Promise<Response> => {
    ensureCaller(req);
    const data = await service.buildUtilizationReport(req.query as unknown as UtilizationReportQuery);
    return ok(res, data);
};

// ─── GET /reports/attendance ─────────────────────────────────────────────

export const getAttendance = async (req: Request, res: Response): Promise<Response> => {
    ensureCaller(req);
    const data = await service.buildAttendanceReport(req.query as unknown as AttendanceReportQuery);
    return ok(res, data);
};

// ─── GET /reports/leaves ─────────────────────────────────────────────────

export const getLeaves = async (req: Request, res: Response): Promise<Response> => {
    ensureCaller(req);
    const data = await service.buildLeaveReport(req.query as unknown as LeaveReportQuery);
    return ok(res, data);
};

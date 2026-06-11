import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/dashboard.service.js';
import * as analytics from '../services/dashboard-analytics.service.js';
import { ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type { DashboardAnalyticsQuery } from '../validators/dashboard.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return new Types.ObjectId(req.user.user_id);
};

const callerRole = (req: Request) => {
    if (!req.user?.role) throw AppError.unauthenticated();
    return req.user.role;
};

// ─── GET /dashboard/admin ─────────────────────────────────────────────────

export const getAdmin = async (_req: Request, res: Response): Promise<Response> => {
    const data = await service.buildAdminDashboard();
    return ok(res, data);
};

// ─── GET /dashboard/manager ───────────────────────────────────────────────

export const getManager = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.buildManagerDashboard({
        id: callerId(req),
        role: callerRole(req),
        // R4 — Step-47 RBAC signal so a multi-role admin gets the
        // admin-scoped dashboard branch.
        role_keys: req.user!.role_keys,
    });
    return ok(res, data);
};

// ─── GET /dashboard/employee ──────────────────────────────────────────────

export const getEmployee = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.buildEmployeeDashboard(callerId(req));
    return ok(res, data);
};

// ─── GET /dashboard/client (V2-BE-2) ──────────────────────────────────────

export const getClient = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.buildClientDashboard(callerId(req));
    return ok(res, data);
};

// ─── Analytics helpers ────────────────────────────────────────────────────

const heldPerms = (req: Request): readonly string[] | undefined => req.user?.permissions;
const rangeKey = (req: Request) => (req.query as unknown as DashboardAnalyticsQuery).range;

// ─── GET /dashboard/admin/analytics ──────────────────────────────────────

export const getAdminAnalytics = async (req: Request, res: Response): Promise<Response> =>
    ok(res, await analytics.buildAdminAnalytics(heldPerms(req), rangeKey(req)));

// ─── GET /dashboard/manager/analytics ────────────────────────────────────

export const getManagerAnalytics = async (req: Request, res: Response): Promise<Response> =>
    ok(
        res,
        await analytics.buildManagerAnalytics(
            { id: callerId(req), role: callerRole(req), role_keys: req.user!.role_keys },
            heldPerms(req),
            rangeKey(req)
        )
    );

// ─── GET /dashboard/employee/analytics ───────────────────────────────────

export const getEmployeeAnalytics = async (req: Request, res: Response): Promise<Response> =>
    ok(res, await analytics.buildEmployeeAnalytics(callerId(req), heldPerms(req), rangeKey(req)));

// ─── GET /dashboard/client/analytics ─────────────────────────────────────

export const getClientAnalytics = async (req: Request, res: Response): Promise<Response> =>
    ok(res, await analytics.buildClientAnalytics(callerId(req), heldPerms(req), rangeKey(req)));

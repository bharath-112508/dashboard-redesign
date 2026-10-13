import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/leave-request.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { AuditContext } from '../services/audit.service.js';
import type { RoleType } from '../constants/roles.js';
import type {
    ApplyLeaveBody,
    ApproveLeaveBody,
    CalendarLeavesQuery,
    CancelLeaveBody,
    ListLeavesQuery,
    RejectLeaveBody,
} from '../validators/leave-request.validator.js';

const caller = (req: Request): { id: Types.ObjectId; role: RoleType } => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return { id: new Types.ObjectId(req.user.user_id), role: req.user.role };
};

/**
 * Caller plus the audit context. Used by approve/reject/cancel — those are
 * the only lifecycle endpoints that emit audit rows. Read-only endpoints
 * keep using the bare `caller(req)` helper to avoid the extra plumbing.
 */
const auditingCaller = (req: Request): { id: Types.ObjectId; role: RoleType; audit: AuditContext } => {
    return { ...caller(req), audit: buildAuditContext(req) };
};

const parseId = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.id as string);

// ─── POST /leaves/preview-split ───────────────────────────────────────────

export const postPreview = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.previewSplit(req.body as ApplyLeaveBody, caller(req));
    return ok(res, data);
};

// ─── POST /leaves ─────────────────────────────────────────────────────────

export const postApply = async (req: Request, res: Response): Promise<Response> => {
    // H4 — use the auditing caller so `applyLeave` emits a
    // `leave.apply` row alongside the request creation. Pre-H4 only
    // approve/reject/cancel were audited.
    const data = await service.applyLeave(req.body as ApplyLeaveBody, auditingCaller(req));
    return created(res, data);
};

// ─── GET /leaves ──────────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listLeaves(req.query as unknown as ListLeavesQuery, caller(req));
    return paginated(res, data, meta);
};

// ─── GET /leaves/calendar ────────────────────────────────────────────────

export const getCalendar = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.calendarLeaves(req.query as unknown as CalendarLeavesQuery);
    return ok(res, data);
};

// ─── GET /leaves/:id ──────────────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getLeave(parseId(req), caller(req));
    return ok(res, data);
};

// ─── POST /leaves/:id/approve ────────────────────────────────────────────

export const postApprove = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.approveLeave(parseId(req), req.body as ApproveLeaveBody, auditingCaller(req));
    return ok(res, data);
};

// ─── POST /leaves/:id/reject ─────────────────────────────────────────────

export const postReject = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.rejectLeave(parseId(req), req.body as RejectLeaveBody, auditingCaller(req));
    return ok(res, data);
};

// ─── POST /leaves/:id/cancel ─────────────────────────────────────────────

export const postCancel = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.cancelLeave(parseId(req), req.body as CancelLeaveBody, auditingCaller(req));
    return ok(res, data);
};

import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/attendance.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { type RoleType } from '../constants/roles.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { AuditContext } from '../services/audit.service.js';
import type {
    BreakStartBody,
    SetMyBreaksBody,
    SetMyTimesBody,
    CheckInBody,
    CheckOutBody,
    ListAttendanceQuery,
    ListCorrectionsQuery,
    MyAttendanceQuery,
    PatchAttendanceBody,
    QrVerifyBody,
    ReviewCorrectionBody,
    SubmitCorrectionBody,
} from '../validators/attendance.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return new Types.ObjectId(req.user.user_id);
};

const callerRole = (req: Request): RoleType => {
    if (!req.user?.role) throw AppError.unauthenticated();
    return req.user.role as RoleType;
};

/**
 * Caller + audit context. Used for admin direct-edit + correction
 * mutations (C1 / 2026-06-05 review). Read-only endpoints keep using
 * the bare `callerId`/`callerRole` helpers to avoid extra plumbing.
 * Mirrors `auditingCaller` in `leave-request.controller.ts`.
 */
const auditingCaller = (req: Request): { id: Types.ObjectId; role: RoleType; audit: AuditContext } => ({
    id: callerId(req),
    role: callerRole(req),
    audit: buildAuditContext(req),
});

const parseTargetId = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.id as string);

const ipOf = (req: Request): string => req.ip ?? req.socket?.remoteAddress ?? '';

// ─── POST /attendance/check-in ───────────────────────────────────────────

export const postCheckIn = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.checkIn(req.body as CheckInBody, callerId(req), ipOf(req));
    return created(res, data);
};

// ─── POST /attendance/check-out ──────────────────────────────────────────

export const postCheckOut = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.checkOut(req.body as CheckOutBody, callerId(req), ipOf(req));
    return ok(res, data);
};

// ─── POST /attendance/qr-verify ──────────────────────────────────────────

export const postQrVerify = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.verifyQr((req.body as QrVerifyBody).qr_token);
    return ok(res, data);
};

// ─── GET /attendance/me/today ────────────────────────────────────────────

export const getMyToday = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getMyToday(callerId(req));
    return ok(res, data);
};

// ─── GET /attendance/me ──────────────────────────────────────────────────

export const getMy = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listMyAttendance(callerId(req), req.query as unknown as MyAttendanceQuery);
    return paginated(res, data, meta);
};

// ─── GET /attendance ─────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listAttendance(req.query as unknown as ListAttendanceQuery, {
        id: callerId(req),
        role: callerRole(req),
    });
    return paginated(res, data, meta);
};

// ─── PATCH /attendance/:id ───────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.patchAttendance(
        parseTargetId(req),
        req.body as PatchAttendanceBody,
        auditingCaller(req)
    );
    return ok(res, data);
};

// ─── POST /attendance/correction-requests ────────────────────────────────

export const postCorrection = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.submitCorrection(req.body as SubmitCorrectionBody, auditingCaller(req));
    return created(res, data);
};

// ─── GET /attendance/correction-requests ─────────────────────────────────

export const getCorrections = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listCorrections(
        req.query as unknown as ListCorrectionsQuery,
        callerId(req),
        callerRole(req)
    );
    return paginated(res, data, meta);
};

// ─── POST /attendance/correction-requests/:id/approve ───────────────────

export const postApproveCorrection = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.approveCorrection(
        parseTargetId(req),
        req.body as ReviewCorrectionBody,
        auditingCaller(req)
    );
    return ok(res, data);
};

// ─── POST /attendance/correction-requests/:id/reject ────────────────────

export const postRejectCorrection = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.rejectCorrection(
        parseTargetId(req),
        req.body as ReviewCorrectionBody,
        auditingCaller(req)
    );
    return ok(res, data);
};

// ─── POST /attendance/correction-requests/:id/cancel (M49) ──────────────

export const postCancelCorrection = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.cancelCorrection(parseTargetId(req), {
        id: callerId(req),
        audit: buildAuditContext(req),
    });
    return ok(res, data);
};

// ─── POST /attendance/break/start ────────────────────────────────────────

export const postBreakStart = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as BreakStartBody;
    const data = await service.startBreak(callerId(req), body.break_type, 'app');
    return ok(res, data);
};

// ─── POST /attendance/break/end ──────────────────────────────────────────

export const postBreakEnd = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.endBreak(callerId(req), 'app');
    return ok(res, data);
};

// ─── PUT /attendance/me/breaks ───────────────────────────────────────────

export const putMyBreaks = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as SetMyBreaksBody;
    const data = await service.setMyBreaks(callerId(req), body.breaks);
    return ok(res, data);
};

// ─── POST /attendance/me/times ───────────────────────────────────────────

export const putMyTimes = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as SetMyTimesBody;
    const data = await service.setMyTimes(callerId(req), body);
    return ok(res, data);
};

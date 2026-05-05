import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/attendance.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { type RoleType } from '../constants/roles.js';
import type {
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
    const { data, meta } = await service.listAttendance(req.query as unknown as ListAttendanceQuery);
    return paginated(res, data, meta);
};

// ─── PATCH /attendance/:id ───────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.patchAttendance(
        parseTargetId(req),
        req.body as PatchAttendanceBody,
        callerId(req),
        callerRole(req)
    );
    return ok(res, data);
};

// ─── POST /attendance/correction-requests ────────────────────────────────

export const postCorrection = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.submitCorrection(req.body as SubmitCorrectionBody, callerId(req));
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
        callerId(req),
        callerRole(req)
    );
    return ok(res, data);
};

// ─── POST /attendance/correction-requests/:id/reject ────────────────────

export const postRejectCorrection = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.rejectCorrection(
        parseTargetId(req),
        req.body as ReviewCorrectionBody,
        callerId(req),
        callerRole(req)
    );
    return ok(res, data);
};

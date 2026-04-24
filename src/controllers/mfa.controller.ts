import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as mfaService from '../services/mfa.service.js';
import { ok, noContent } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type {
    MfaDisableBody,
    MfaRegenerateBody,
    MfaSetupConfirmBody,
    MfaVerifyBody,
} from '../validators/mfa.validator.js';

const clientIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? '';
const userAgent = (req: Request): string => (req.headers['user-agent'] ?? '').toString().slice(0, 256);

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) {
        throw AppError.unauthenticated();
    }
    return new Types.ObjectId(req.user.user_id);
};

// ─── Public (MFA session token in body) ────────────────────────────────────
export const postMfaVerify = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as MfaVerifyBody;
    const result = await mfaService.verify({
        mfa_session_token: body.mfa_session_token,
        code: body.code,
        is_backup_code: body.is_backup_code,
        device_info: userAgent(req),
        ip_address: clientIp(req),
    });
    return ok(res, result);
};

// ─── Authenticated ─────────────────────────────────────────────────────────
export const postMfaSetupInit = async (req: Request, res: Response): Promise<Response> => {
    const id = callerId(req);
    const result = await mfaService.setupInit(id);
    return ok(res, result);
};

export const postMfaSetupConfirm = async (req: Request, res: Response): Promise<Response> => {
    const id = callerId(req);
    const body = req.body as MfaSetupConfirmBody;
    const result = await mfaService.setupConfirm(id, body.code);
    return ok(res, result);
};

export const postMfaDisable = async (req: Request, res: Response): Promise<Response> => {
    const id = callerId(req);
    const body = req.body as MfaDisableBody;
    await mfaService.disable({ user_id: id, password: body.password, code: body.code });
    return noContent(res);
};

export const postMfaRegenerateBackupCodes = async (req: Request, res: Response): Promise<Response> => {
    const id = callerId(req);
    const body = req.body as MfaRegenerateBody;
    const result = await mfaService.regenerateBackupCodes({ user_id: id, code: body.code });
    return ok(res, result);
};

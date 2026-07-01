import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/letter.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { GenerateLetterBody, ListLettersQuery } from '../validators/letter.validator.js';

const callerOf = (req: Request): service.PayrollCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return { id: new Types.ObjectId(req.user.user_id), audit: buildAuditContext(req) };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── POST /letters ────────────────────────────────────────────────────────

export const postGenerate = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as GenerateLetterBody;
    const data = await service.generateLetter(body, callerOf(req));
    return created(res, data);
};

// ─── GET /letters ─────────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listLetters(req.query as unknown as ListLettersQuery);
    return paginated(res, data, meta);
};

// ─── GET /letters/:id/download ───────────────────────────────────────────

export const getDownload = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.downloadLetter(idOf(req, 'id'));
    return ok(res, data);
};

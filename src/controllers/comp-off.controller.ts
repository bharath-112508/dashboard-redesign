import { Request, Response } from 'express';
import { Types } from 'mongoose';

import { StatusCodes } from 'http-status-codes';

import * as service from '../services/comp-off.service.js';
import { buildAuditContext } from '../utils/audit-context.js';
import { created, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type { RoleType } from '../constants/roles.js';
import type { AdjustCompOffBody, ListCompOffQuery, MyCompOffQuery } from '../validators/comp-off.validator.js';

const caller = (req: Request): { id: Types.ObjectId; role: RoleType } => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return { id: new Types.ObjectId(req.user.user_id), role: req.user.role };
};

export const getMine = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta, balance } = await service.listOwnCompOff(req.query as unknown as MyCompOffQuery, caller(req));
    // Custom envelope: ledger items + cached comp-off balance + pagination.
    return res.status(StatusCodes.OK).json({ data, meta, balance });
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listCompOff(req.query as unknown as ListCompOffQuery);
    return paginated(res, data, meta);
};

export const postAdjust = async (req: Request, res: Response): Promise<Response> => {
    // I1 — thread audit context so the admin's grant/consume is recorded
    // with operator-supplied `remarks` + signed delta.
    const data = await service.adjustCompOff(req.body as AdjustCompOffBody, caller(req), buildAuditContext(req));
    return created(res, data);
};

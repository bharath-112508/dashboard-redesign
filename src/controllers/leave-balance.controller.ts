import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/leave-balance.service.js';
import { created, ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type {
    AdjustLeaveBalanceBody,
    InitializeYearBody,
    ListLeaveBalancesQuery,
    MyBalancesQuery,
} from '../validators/leave-balance.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return new Types.ObjectId(req.user.user_id);
};
const parseId = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.id as string);

// ─── GET /leave-balances/me ───────────────────────────────────────────────

export const getMine = async (req: Request, res: Response): Promise<Response> => {
    const q = req.query as unknown as MyBalancesQuery;
    const data = await service.listOwnBalances(callerId(req), q.year);
    return ok(res, data);
};

// ─── GET /leave-balances ──────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.listBalances(req.query as unknown as ListLeaveBalancesQuery);
    return ok(res, data);
};

// ─── PATCH /leave-balances/:id ────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.adjustBalance(parseId(req), req.body as AdjustLeaveBalanceBody, callerId(req));
    return ok(res, data);
};

// ─── POST /leave-balances/initialize-year ─────────────────────────────────

export const postInitializeYear = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.initializeYearForAllUsers(req.body as InitializeYearBody);
    return created(res, data);
};

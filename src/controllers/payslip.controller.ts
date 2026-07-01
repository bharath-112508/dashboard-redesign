import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/payslip.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { GeneratePayslipBody, ListPayslipsQuery } from '../validators/payslip.validator.js';

const callerOf = (req: Request): service.PayrollCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return { id: new Types.ObjectId(req.user.user_id), audit: buildAuditContext(req) };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── POST /payslips ──────────────────────────────────────────────────────

export const postGenerate = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as GeneratePayslipBody;
    const data = await service.generatePayslip(
        {
            user_id: new Types.ObjectId(body.user_id),
            pay_period: body.pay_period,
            days_present: body.days_present,
            effective_on: body.effective_on,
        },
        callerOf(req)
    );
    return created(res, data);
};

// ─── GET /payslips ───────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listPayslips(req.query as unknown as ListPayslipsQuery);
    return paginated(res, data, meta);
};

// ─── GET /payslips/:id/download ──────────────────────────────────────────

export const getDownload = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.downloadPayslip(idOf(req, 'id'));
    return ok(res, data);
};

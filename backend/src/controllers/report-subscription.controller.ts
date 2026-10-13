import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/report-subscription.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type {
    CreateReportSubscriptionBody,
    ListReportSubscriptionsQuery,
    PatchReportSubscriptionBody,
    ReportSubscriptionIdParam,
} from '../validators/report-subscription.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return new Types.ObjectId(req.user.user_id);
};

const idOf = (req: Request): Types.ObjectId =>
    new Types.ObjectId((req.params as unknown as ReportSubscriptionIdParam).id);

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createSubscription(
        req.body as CreateReportSubscriptionBody,
        callerId(req),
        buildAuditContext(req)
    );
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listSubscriptions(
        req.query as unknown as ListReportSubscriptionsQuery,
        callerId(req)
    );
    return paginated(res, data, meta);
};

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getSubscription(idOf(req), callerId(req));
    return ok(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateSubscription(
        idOf(req),
        req.body as PatchReportSubscriptionBody,
        callerId(req),
        buildAuditContext(req)
    );
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteSubscription(idOf(req), callerId(req), buildAuditContext(req));
    return ok(res, data);
};

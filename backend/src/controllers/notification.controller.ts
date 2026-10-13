import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/notification.service.js';
import { noContent, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type { ListNotificationsQuery } from '../validators/notification.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return new Types.ObjectId(req.user.user_id);
};

const parseTargetId = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.id as string);

// ─── GET /notifications ──────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listNotifications(
        req.query as unknown as ListNotificationsQuery,
        callerId(req)
    );
    return paginated(res, data, meta);
};

// ─── GET /notifications/unread-count ─────────────────────────────────────

export const getUnreadCount = async (req: Request, res: Response): Promise<Response> => {
    const count = await service.unreadCount(callerId(req));
    return ok(res, { count });
};

// ─── POST /notifications/:id/read ────────────────────────────────────────

export const postMarkRead = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.markRead(parseTargetId(req), callerId(req));
    return ok(res, data);
};

// ─── POST /notifications/read-all ────────────────────────────────────────

export const postMarkAllRead = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.markAllRead(callerId(req));
    return ok(res, data);
};

// ─── DELETE /notifications/:id ───────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.dismissNotification(parseTargetId(req), callerId(req));
    return noContent(res);
};

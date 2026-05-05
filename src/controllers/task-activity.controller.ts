import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/task-activity.service.js';
import { paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { ProjectCaller } from '../services/project.service.js';
import type { RoleType } from '../constants/roles.js';
import type { ListActivitiesQuery } from '../validators/task-activity.validator.js';

/**
 * Task-activity controller — thin Express adapter for the read-only
 * activity feed (`GET /tasks/:task_id/activity`). Phase 1 has no write
 * endpoints; activity rows are produced by the task / task-comment
 * service hooks.
 */

const callerOf = (req: Request): ProjectCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        role: req.user.role as RoleType,
        role_keys: req.user.role_keys,
        audit: buildAuditContext(req),
    };
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listActivities(
        new Types.ObjectId(req.params.task_id as string),
        req.query as unknown as ListActivitiesQuery,
        callerOf(req)
    );
    return paginated(res, data, meta);
};

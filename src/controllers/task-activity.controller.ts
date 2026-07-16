import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/task-activity.service.js';
import { paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type { ListActivitiesQuery } from '../validators/task-activity.validator.js';

/**
 * Task-activity controller — thin Express adapter for the read-only
 * activity feed (`GET /tasks/:task_id/activity`). Phase 1 has no write
 * endpoints; activity rows are produced by the task / task-comment
 * service hooks.
 */

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listActivities(
        new Types.ObjectId(req.params.task_id as string),
        req.query as unknown as ListActivitiesQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

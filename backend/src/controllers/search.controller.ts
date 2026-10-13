import { Request, Response } from 'express';

import * as service from '../services/search.service.js';
import { ok } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type { SearchQuery } from '../validators/search.validator.js';

/**
 * Global-search controller (Step 32; API_Contract §13).
 *
 * Thin pass-through. Auth + role gating happens at the route layer;
 * per-bucket visibility scoping happens inside the service.
 */
export const getSearch = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.search(req.query as unknown as SearchQuery, projectCallerFrom(req));
    return ok(res, data);
};

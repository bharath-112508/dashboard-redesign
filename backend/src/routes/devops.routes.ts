import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { created, ok } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import * as svc from '../services/devops.service.js';

/**
 * Redesign: the DevOps board. Every signed-in person may read (clients only
 * their company's items); the service decides who may write.
 */
const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const key = z.string().regex(/^OPS-\d{1,6}$/);
const data = z.record(z.string(), z.unknown());
const log = z.object({ type: z.string().max(40), text: z.string().max(2000), detail: z.string().max(2000).optional() }).strict();

const router = Router();
router.use(authenticate);

router.get('/items', asyncHandler(async (req: Request, res: Response) => ok(res, await svc.listItems(projectCallerFrom(req)))));
router.post(
    '/items',
    validate({ body: z.object({ key, project_id: objectId, data }).strict() }),
    asyncHandler(async (req: Request, res: Response) => created(res, await svc.createItem(req.body, projectCallerFrom(req))))
);
router.patch(
    '/items/:key',
    validate({ params: z.object({ key }), body: z.object({ patch: data, log: log.optional() }).strict() }),
    asyncHandler(async (req: Request, res: Response) =>
        ok(res, await svc.updateItem(String(req.params.key), req.body, projectCallerFrom(req)))
    )
);
router.get('/settings', asyncHandler(async (_req: Request, res: Response) => ok(res, await svc.getDevopsSettings())));
router.put(
    '/settings',
    validate({ body: z.object({ settings: data }).strict() }),
    asyncHandler(async (req: Request, res: Response) => ok(res, await svc.setDevopsSettings(req.body.settings, projectCallerFrom(req))))
);
export default router;

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { ok } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import * as svc from '../services/invoicematch.service.js';

/** Redesign: decisions in the InvoiceMatch live-app demo; the service decides who may see the project. */
const params = z.object({ projectId: z.string().regex(/^[a-f0-9]{24}$/i) });
const withNo = params.extend({ no: z.string().trim().min(1).max(40) });

const router = Router();
router.use(authenticate);
router.get(
    '/:projectId/decisions',
    validate({ params }),
    asyncHandler(async (req: Request, res: Response) => ok(res, await svc.listDecisions(String(req.params.projectId), projectCallerFrom(req))))
);
router.put(
    '/:projectId/decisions/:no',
    validate({ params: withNo, body: z.object({ st: z.enum(['approved', 'hold', 'rejected']), note: z.string().max(2000) }).strict() }),
    asyncHandler(async (req: Request, res: Response) =>
        ok(res, await svc.decide(String(req.params.projectId), String(req.params.no), req.body, projectCallerFrom(req)))
    )
);
router.delete(
    '/:projectId/decisions/:no',
    validate({ params: withNo }),
    asyncHandler(async (req: Request, res: Response) =>
        ok(res, await svc.undo(String(req.params.projectId), String(req.params.no), projectCallerFrom(req)))
    )
);
export default router;

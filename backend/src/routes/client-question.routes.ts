import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { created, ok } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import * as svc from '../services/client-question.service.js';

/**
 * Redesign: questions to clients (`/questions`) and requests to DevOps
 * (`/devops-requests`). Every signed-in person may call them; the service
 * scopes clients to their company and decides who may write what.
 */

/** Files stay inline (data URLs) until blob uploads are switched on; the 1 MB body limit caps their size. */
const file = z.object({ name: z.string().max(200), size: z.string().max(20), url: z.string().max(1_400_000), img: z.boolean() }).strict();
const files = z.array(file).max(5);
const num = z.object({ number: z.coerce.number().int().positive() });
const short = z.string().trim().max(200);
const title = z.string().trim().min(1).max(1000);
const long = z.string().max(10_000);

const questionFields = {
    title,
    text: long,
    photos: files,
    qtype: short,
    qprio: short,
    sprint: short.nullable(),
    solved: z.boolean(),
    seen_t: z.number().int().min(0),
};
const createQuestion = z
    .object({
        number: z.number().int().positive(),
        task_id: z.string().max(40).nullable().optional(),
        devops_key: z.string().regex(/^OPS-\d{1,6}$/).nullable().optional(),
        from_devops: z.boolean().optional(),
        ...questionFields,
    })
    .partial({ text: true, photos: true, qtype: true, qprio: true, sprint: true, solved: true, seen_t: true })
    .strict();

const requestFields = {
    type: short,
    prio: short,
    to: short,
    text: z.string().trim().min(1).max(10_000),
    desc: long,
    due: short,
    start: short,
    est: short,
    status: z.enum(['Open', 'In progress', 'Done']),
    logs: z.array(z.record(z.string(), z.unknown())).max(500),
    seen_t: z.number().int().min(0),
    status_seen: short,
};
const createRequest = z
    .object({
        number: z.number().int().positive(),
        devops_key: z.string().regex(/^OPS-\d{1,6}$/),
        pname: short,
        rkey: short,
        raised: short,
        ...requestFields,
    })
    .partial({ pname: true, rkey: true, raised: true, type: true, prio: true, to: true, desc: true, due: true, start: true, est: true, status: true, logs: true, seen_t: true, status_seen: true })
    .strict();

const call = (fn: (req: Request) => Promise<unknown>, status: 'ok' | 'created' = 'ok') =>
    asyncHandler(async (req: Request, res: Response) => (status === 'created' ? created : ok)(res, await fn(req)));

export const questionRoutes = Router();
questionRoutes.use(authenticate);
questionRoutes.get('/', call((req) => svc.listQuestions(projectCallerFrom(req))));
questionRoutes.post('/', validate({ body: createQuestion }), call((req) => svc.createQuestion(req.body, projectCallerFrom(req)), 'created'));
questionRoutes.patch(
    '/:number',
    validate({ params: num, body: z.object(questionFields).partial().strict() }),
    call((req) => svc.updateQuestion(Number(req.params.number), req.body, projectCallerFrom(req)))
);
questionRoutes.post(
    '/:number/photos',
    validate({ params: num, body: z.object({ files: files.min(1) }).strict() }),
    call((req) => svc.addPhotos(Number(req.params.number), req.body.files, projectCallerFrom(req)), 'created')
);
questionRoutes.post(
    '/:number/messages',
    validate({ params: num, body: z.object({ text: long, files }).strict() }),
    call((req) => svc.addMessage(Number(req.params.number), req.body, projectCallerFrom(req)), 'created')
);
questionRoutes.patch(
    '/:number/messages/:index',
    validate({ params: num.extend({ index: z.coerce.number().int().min(0) }), body: z.object({ text: long }).strict() }),
    call((req) => svc.editMessage(Number(req.params.number), Number(req.params.index), req.body.text, projectCallerFrom(req)))
);

export const devopsRequestRoutes = Router();
devopsRequestRoutes.use(authenticate);
devopsRequestRoutes.get('/', call((req) => svc.listRequests(projectCallerFrom(req))));
devopsRequestRoutes.post('/', validate({ body: createRequest }), call((req) => svc.createRequest(req.body, projectCallerFrom(req)), 'created'));
devopsRequestRoutes.patch(
    '/:number',
    validate({
        params: num,
        body: z.object({ patch: z.object(requestFields).partial().strict(), log: z.object({ text: long }).strict().optional() }).strict(),
    }),
    call((req) => svc.updateRequest(Number(req.params.number), req.body, projectCallerFrom(req)))
);
devopsRequestRoutes.post(
    '/:number/comments',
    validate({ params: num, body: z.object({ text: z.string().trim().min(1).max(10_000), side: z.enum(['tickets', 'devops']) }).strict() }),
    call((req) => svc.addRequestComment(Number(req.params.number), req.body, projectCallerFrom(req)), 'created')
);

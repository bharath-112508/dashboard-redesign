import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';

import { validate } from './validate.middleware.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * Unit tests for the validate middleware (Step 12 + Step 15.2).
 *
 * Coverage focus is the contract callers depend on:
 *  1. Valid body parses & is overwritten on the request.
 *  2. Invalid body throws `AppError.validation` with `{ field, message }`
 *     details so the global handler can render API_Contract §1.5.
 *  3. **Empty-body coercion (15.2):** when the body is `undefined` (no JSON
 *     payload at all) and the schema is an object schema, the middleware
 *     parses `{}` instead of failing with a confusing whole-body error.
 *  4. Non-zod errors propagate unchanged so unrelated infra failures don't
 *     get masked as `VALIDATION_ERROR`.
 */

const buildReq = (init: Partial<Request> = {}): Request =>
    ({
        body: undefined,
        query: undefined,
        params: undefined,
        ...init,
    }) as unknown as Request;

const noopRes = {} as Response;

const runMiddleware = async (
    middleware: ReturnType<typeof validate>,
    req: Request
): Promise<{ next: NextFunction; nextArg: unknown; req: Request }> => {
    const next = vi.fn();
    await middleware(req, noopRes, next as NextFunction);
    return { next, nextArg: next.mock.calls[0]?.[0], req };
};

describe('validate middleware — body', () => {
    const schema = z.object({
        reason: z.string().trim().min(1).max(500).optional(),
    });

    it('parses a well-formed body and writes it back on req', async () => {
        const req = buildReq({ body: { reason: '  hi  ' } });

        const { nextArg } = await runMiddleware(validate({ body: schema }), req);

        expect(nextArg).toBeUndefined();
        expect(req.body).toEqual({ reason: 'hi' });
    });

    it('treats an undefined body as `{}` for object schemas (Step 15.2)', async () => {
        const req = buildReq({ body: undefined });

        const { nextArg } = await runMiddleware(validate({ body: schema }), req);

        expect(nextArg).toBeUndefined();
        expect(req.body).toEqual({});
    });

    it('treats a null body as `{}` for object schemas', async () => {
        const req = buildReq({ body: null as unknown as object });

        const { nextArg } = await runMiddleware(validate({ body: schema }), req);

        expect(nextArg).toBeUndefined();
        expect(req.body).toEqual({});
    });

    it('still surfaces field-level Zod errors when required fields are missing', async () => {
        const required = z.object({ name: z.string().min(1) });
        const req = buildReq({ body: {} });

        const { nextArg } = await runMiddleware(validate({ body: required }), req);

        expect(nextArg).toBeInstanceOf(AppError);
        const err = nextArg as AppError;
        expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        expect(err.statusCode).toBe(400);
        expect(err.details).toMatchObject({
            errors: [{ field: 'name', message: expect.any(String) }],
        });
    });

    it('does NOT coerce when the body schema is not an object (e.g. union/array)', async () => {
        const arraySchema = z.array(z.string());
        const req = buildReq({ body: undefined });

        const { nextArg } = await runMiddleware(validate({ body: arraySchema }), req);

        // undefined is not coerced to []; the schema rejects undefined.
        expect(nextArg).toBeInstanceOf(AppError);
    });
});

describe('validate middleware — query / params', () => {
    it('parses query and overwrites the (Express 5 getter-only) req.query', async () => {
        const querySchema = z.object({ page: z.coerce.number().int().min(1) });
        // Express 5 makes `req.query` a getter; the middleware uses
        // `defineProperty` to replace it. Simulate by giving the prop a
        // getter and asserting the post-middleware value still reads back.
        const req = buildReq({});
        Object.defineProperty(req, 'query', {
            value: { page: '7' },
            configurable: true,
            enumerable: true,
        });

        const { nextArg } = await runMiddleware(validate({ query: querySchema }), req);

        expect(nextArg).toBeUndefined();
        expect((req.query as unknown as { page: number }).page).toBe(7);
    });

    it('propagates non-Zod errors unchanged', async () => {
        const explodingSchema = {
            parseAsync: () => {
                throw new Error('infra blew up');
            },
        } as unknown as z.ZodType<unknown>;

        const { nextArg } = await runMiddleware(validate({ body: explodingSchema }), buildReq({ body: { x: 1 } }));

        expect(nextArg).toBeInstanceOf(Error);
        expect(nextArg).not.toBeInstanceOf(AppError);
        expect((nextArg as Error).message).toBe('infra blew up');
    });
});

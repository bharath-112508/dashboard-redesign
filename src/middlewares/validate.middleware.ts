import { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/app-error.js';

type ZodSchema = z.ZodType<unknown>;

interface ValidationSchema {
    body?: ZodSchema;
    query?: ZodSchema;
    params?: ZodSchema;
}

/**
 * Middleware to validate request body, query, and URL params using Zod schemas.
 *
 * Writes the parsed result back onto the request so downstream controllers
 * see coerced / defaulted values. Express 5 made `req.query` a getter-only
 * accessor, so we assign via `Object.defineProperty` rather than the usual
 * `Object.assign`, which would silently no-op.
 *
 * Empty-body coercion (Step 15.2):
 *   For object body schemas, an absent / null / undefined `req.body` is
 *   treated as `{}` before parsing. This lets every "all-fields-optional"
 *   action (e.g. `POST /users/:id/deactivate`, `POST /leaves/:id/cancel`
 *   when `reason` is optional) accept a request with no JSON payload at
 *   all — which is what `curl -X POST` sends without `-d` and what
 *   browsers send when the FE skips the body for an optional-reason flow.
 *   Schemas that genuinely require fields still surface the same Zod
 *   "Required" error, just at the field level instead of the whole-body
 *   level — much better DX and matches API_Contract §1.5 expectations.
 *
 * On failure: `AppError.validation(...)` with details shaped as
 * `{ errors: [{ field, message }] }` (API_Contract §1.5 / §15 VALIDATION_ERROR).
 */
const overwrite = <T extends object>(host: Request, prop: 'query' | 'params' | 'body', value: T) => {
    Object.defineProperty(host, prop, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
    });
};

const isObjectSchema = (schema: ZodSchema): boolean => {
    // Zod 4 keeps the discriminator on the internal def; we walk the public
    // surface only so a future Zod release can't accidentally tip this into
    // a `.toString()` of a private symbol. `ZodObject` has a `.shape` getter.
    return typeof (schema as unknown as { shape?: unknown }).shape !== 'undefined';
};

const coerceBody = (raw: unknown, schema: ZodSchema): unknown => {
    if (raw !== undefined && raw !== null) return raw;
    return isObjectSchema(schema) ? {} : raw;
};

export const validate = (schema: ValidationSchema): RequestHandler => {
    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            if (schema.body) {
                const coerced = coerceBody(req.body, schema.body);
                const parsed = await schema.body.parseAsync(coerced);
                overwrite(req, 'body', parsed as object);
            }
            if (schema.query) {
                const parsed = await schema.query.parseAsync(req.query);
                overwrite(req, 'query', parsed as object);
            }
            if (schema.params) {
                const parsed = await schema.params.parseAsync(req.params);
                overwrite(req, 'params', parsed as object);
            }
            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                const details = {
                    errors: error.issues.map((issue: z.ZodIssue) => ({
                        field: issue.path.join('.'),
                        message: issue.message,
                    })),
                };
                next(AppError.validation('Validation failed', details));
            } else {
                next(error);
            }
        }
    };
};

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

export const validate = (schema: ValidationSchema): RequestHandler => {
    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            if (schema.body) {
                const parsed = await schema.body.parseAsync(req.body);
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

import { Request, Response, NextFunction } from 'express';
import { Error as MongooseError } from 'mongoose';
import jwt from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';

import { AppError } from '../utils/app-error.js';
import logger from '../utils/logger.js';
import { NODE_ENV } from '../config/server.config.js';
import { ERROR_CODES, type ErrorCode } from '../constants/error-codes.js';

interface ErrorBody {
    error: { code: ErrorCode; message: string; details?: unknown };
}

const buildErrorBody = (code: ErrorCode, message: string, details?: unknown): ErrorBody => {
    return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
};

export const globalErrorHandler = (err: Error, _req: Request, res: Response, _next: NextFunction): Response | void => {
    // App-level errors — already carry code + status + details
    if (err instanceof AppError) {
        logger.error(
            { err, status: err.statusCode, code: err.code, details: err.details },
            `App error: ${err.message}`
        );
        return res.status(err.statusCode).json(buildErrorBody(err.code, err.message, err.details));
    }

    // JWT — mapped to TOKEN_EXPIRED / UNAUTHENTICATED
    if (err instanceof jwt.TokenExpiredError) {
        logger.warn({ err }, 'JWT expired');
        return res
            .status(StatusCodes.UNAUTHORIZED)
            .json(buildErrorBody(ERROR_CODES.TOKEN_EXPIRED, 'Token expired, please login again'));
    }

    if (err instanceof jwt.JsonWebTokenError) {
        logger.warn({ err }, 'JWT invalid');
        return res.status(StatusCodes.UNAUTHORIZED).json(buildErrorBody(ERROR_CODES.UNAUTHENTICATED, 'Invalid token'));
    }

    // Invalid ObjectId in the URL
    if (err instanceof MongooseError.CastError) {
        logger.warn({ err }, 'Invalid ID format');
        return res.status(StatusCodes.BAD_REQUEST).json(
            buildErrorBody(ERROR_CODES.VALIDATION_ERROR, 'Invalid ID format', {
                field: err.path,
            })
        );
    }

    // Mongoose validation error
    if (err instanceof MongooseError.ValidationError) {
        const details = {
            errors: Object.values(err.errors).map((e) => ({
                field: e.path,
                message: e.message,
            })),
        };
        logger.warn({ err }, 'Mongoose validation failed');
        return res
            .status(StatusCodes.BAD_REQUEST)
            .json(buildErrorBody(ERROR_CODES.VALIDATION_ERROR, 'Validation failed', details));
    }

    // Duplicate key (E11000). R14 — echo only field NAMES, never the
    // conflicting values. The `keyValue` payload includes the actual
    // collided values (e.g. raw token strings, email addresses); the
    // caller already supplied the value, so echoing it adds nothing
    // and would leak server-side tokens / synthetic GDPR emails / etc.
    // back over the wire.
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
        const dupErr = err as { keyValue?: Record<string, unknown>; keyPattern?: Record<string, unknown> };
        logger.warn({ err: dupErr }, 'Duplicate key');
        const fieldNames = Object.keys(dupErr.keyValue ?? dupErr.keyPattern ?? {});
        return res.status(StatusCodes.CONFLICT).json(
            buildErrorBody(ERROR_CODES.DUPLICATE_RESOURCE, 'Resource already exists', {
                fields: fieldNames,
            })
        );
    }

    // Fallback
    logger.error({ err }, 'Unhandled internal error');
    return res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json(
            buildErrorBody(
                ERROR_CODES.INTERNAL_ERROR,
                NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message || 'Unknown error'
            )
        );
};

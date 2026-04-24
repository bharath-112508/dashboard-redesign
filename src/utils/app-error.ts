import { StatusCodes } from 'http-status-codes';
import { ERROR_CODES, type ErrorCode } from '../constants/error-codes.js';

/**
 * Application-level error carrying HTTP status + canonical error code + optional details.
 * Thrown anywhere in the request pipeline; caught by `globalErrorHandler` which
 * shapes the response per API_Contract §1.5.
 */
export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code: ErrorCode;
    public readonly details?: unknown;

    constructor(params: { message: string; statusCode: number; code: ErrorCode; details?: unknown }) {
        super(params.message);
        this.name = 'AppError';
        this.statusCode = params.statusCode;
        this.code = params.code;
        this.details = params.details;
        Object.setPrototypeOf(this, AppError.prototype);
    }

    // ─── 400 ───────────────────────────────────────────────────────────────
    static validation(message = 'Validation failed', details?: unknown): AppError {
        return new AppError({
            statusCode: StatusCodes.BAD_REQUEST,
            code: ERROR_CODES.VALIDATION_ERROR,
            message,
            details,
        });
    }

    static badRequest(message: string, code: ErrorCode = ERROR_CODES.VALIDATION_ERROR, details?: unknown): AppError {
        return new AppError({ statusCode: StatusCodes.BAD_REQUEST, code, message, details });
    }

    // ─── 401 ───────────────────────────────────────────────────────────────
    static unauthenticated(message = 'Authentication required'): AppError {
        return new AppError({
            statusCode: StatusCodes.UNAUTHORIZED,
            code: ERROR_CODES.UNAUTHENTICATED,
            message,
        });
    }

    static invalidCredentials(message = 'Invalid credentials'): AppError {
        return new AppError({
            statusCode: StatusCodes.UNAUTHORIZED,
            code: ERROR_CODES.INVALID_CREDENTIALS,
            message,
        });
    }

    static tokenExpired(message = 'Token expired, please login again'): AppError {
        return new AppError({
            statusCode: StatusCodes.UNAUTHORIZED,
            code: ERROR_CODES.TOKEN_EXPIRED,
            message,
        });
    }

    // ─── 403 ───────────────────────────────────────────────────────────────
    static forbidden(message = 'Insufficient permissions', code: ErrorCode = ERROR_CODES.FORBIDDEN): AppError {
        return new AppError({ statusCode: StatusCodes.FORBIDDEN, code, message });
    }

    // ─── 404 ───────────────────────────────────────────────────────────────
    static notFound(message = 'Resource not found', code: ErrorCode = ERROR_CODES.RESOURCE_NOT_FOUND): AppError {
        return new AppError({ statusCode: StatusCodes.NOT_FOUND, code, message });
    }

    // ─── 409 ───────────────────────────────────────────────────────────────
    static conflict(message: string, code: ErrorCode = ERROR_CODES.DUPLICATE_RESOURCE, details?: unknown): AppError {
        return new AppError({ statusCode: StatusCodes.CONFLICT, code, message, details });
    }

    // ─── 422 ───────────────────────────────────────────────────────────────
    static unprocessable(message: string, code: ErrorCode, details?: unknown): AppError {
        return new AppError({ statusCode: StatusCodes.UNPROCESSABLE_ENTITY, code, message, details });
    }

    // ─── 423 ───────────────────────────────────────────────────────────────
    static accountLocked(message = 'Account temporarily locked. Please retry later.'): AppError {
        return new AppError({
            statusCode: StatusCodes.LOCKED,
            code: ERROR_CODES.ACCOUNT_LOCKED,
            message,
        });
    }

    // ─── 500 ───────────────────────────────────────────────────────────────
    static internal(message = 'Internal server error'): AppError {
        return new AppError({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            code: ERROR_CODES.INTERNAL_ERROR,
            message,
        });
    }
}

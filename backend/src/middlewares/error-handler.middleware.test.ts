import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { Error as MongooseError } from 'mongoose';

import { globalErrorHandler } from './error-handler.middleware.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * Coverage focus for the global error handler — the contract every
 * controller and middleware silently relies on:
 *
 *   1. `AppError` instances surface their declared status / code / details.
 *   2. JWT-typed errors map to canonical 401 codes (TOKEN_EXPIRED vs
 *      UNAUTHENTICATED) — the auth flow's UX depends on this distinction.
 *   3. Mongoose CastError + ValidationError surface as 400 VALIDATION_ERROR
 *      with field-level detail.
 *   4. Mongo E11000 surfaces as 409 DUPLICATE_RESOURCE — and CRITICALLY
 *      echoes only field NAMES, never the raw collided values (R14
 *      defence: stops raw refresh tokens / synthetic GDPR emails from
 *      leaking back to the caller).
 *   5. Unhandled errors fall back to 500 INTERNAL_ERROR. In production
 *      the message is genericised; in non-production the original
 *      message comes through for debugging.
 */

const mockResponse = () => {
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
    return res as unknown as Parameters<typeof globalErrorHandler>[2] & {
        status: ReturnType<typeof vi.fn>;
        json: ReturnType<typeof vi.fn>;
    };
};

const mockReq = () => ({}) as Parameters<typeof globalErrorHandler>[1];
const mockNext = (() => undefined) as Parameters<typeof globalErrorHandler>[3];

const lastJsonPayload = (
    res: ReturnType<typeof mockResponse>
): { error: { code: string; message: string; details?: unknown } } =>
    res.json.mock.calls[0]![0] as { error: { code: string; message: string; details?: unknown } };

beforeEach(() => {
    vi.clearAllMocks();
});

describe('AppError handling', () => {
    it('preserves statusCode + code + message + details', () => {
        const err = AppError.conflict('Email already exists', ERROR_CODES.EMAIL_ALREADY_EXISTS, {
            email: 'foo@bar.com',
        });
        const res = mockResponse();
        globalErrorHandler(err, mockReq(), res, mockNext);

        expect(res.status).toHaveBeenCalledWith(409);
        const body = lastJsonPayload(res);
        expect(body.error.code).toBe(ERROR_CODES.EMAIL_ALREADY_EXISTS);
        expect(body.error.message).toBe('Email already exists');
        expect(body.error.details).toEqual({ email: 'foo@bar.com' });
    });

    it('omits the details key entirely when undefined (not a stray null)', () => {
        const err = AppError.forbidden();
        const res = mockResponse();
        globalErrorHandler(err, mockReq(), res, mockNext);

        const body = lastJsonPayload(res);
        // Pre-existing contract: clients shouldn't see `details: undefined` /
        // `details: null` in the JSON. The key is simply absent.
        expect(Object.prototype.hasOwnProperty.call(body.error, 'details')).toBe(false);
    });
});

describe('JWT error mapping', () => {
    it('TokenExpiredError → 401 TOKEN_EXPIRED', () => {
        const err = new jwt.TokenExpiredError('jwt expired', new Date());
        const res = mockResponse();
        globalErrorHandler(err, mockReq(), res, mockNext);

        expect(res.status).toHaveBeenCalledWith(401);
        const body = lastJsonPayload(res);
        expect(body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
    });

    it('JsonWebTokenError (non-expired) → 401 UNAUTHENTICATED', () => {
        // The two JWT errors map to DIFFERENT codes so the FE can show
        // "your session expired, please log in" vs "invalid token". A
        // regression that collapsed both to one code would degrade UX.
        const err = new jwt.JsonWebTokenError('jwt malformed');
        const res = mockResponse();
        globalErrorHandler(err, mockReq(), res, mockNext);

        expect(res.status).toHaveBeenCalledWith(401);
        const body = lastJsonPayload(res);
        expect(body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });
});

describe('Mongoose CastError → 400 VALIDATION_ERROR', () => {
    it('echoes the field name in details', () => {
        const err = new MongooseError.CastError('ObjectId', 'not-an-id', '_id');
        const res = mockResponse();
        globalErrorHandler(err, mockReq(), res, mockNext);

        expect(res.status).toHaveBeenCalledWith(400);
        const body = lastJsonPayload(res);
        expect(body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        expect((body.error.details as { field: string }).field).toBe('_id');
    });
});

describe('Mongoose ValidationError → 400 VALIDATION_ERROR with per-field detail', () => {
    it('flattens errors[] into {field, message} pairs', () => {
        const err = new MongooseError.ValidationError();
        // Build two synthetic field-level errors. The shape Mongoose's
        // ValidationError carries internally is `ValidatorError`, but the
        // error-handler only reads `path` + `message`, so the duck-typed
        // shape below is sufficient. Cast through `unknown` to satisfy
        // the structural-incompatibility check on the index signature.
        err.errors = {
            email: Object.assign(new Error('Email is required'), { path: 'email', message: 'Email is required' }),
            age: Object.assign(new Error('Age must be positive'), { path: 'age', message: 'Age must be positive' }),
        } as unknown as MongooseError.ValidationError['errors'];

        const res = mockResponse();
        globalErrorHandler(err, mockReq(), res, mockNext);

        expect(res.status).toHaveBeenCalledWith(400);
        const body = lastJsonPayload(res);
        expect(body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        const errors = (body.error.details as { errors: { field: string; message: string }[] }).errors;
        expect(errors).toHaveLength(2);
        expect(errors).toEqual(
            expect.arrayContaining([
                { field: 'email', message: 'Email is required' },
                { field: 'age', message: 'Age must be positive' },
            ])
        );
    });
});

describe('Mongo E11000 (duplicate key) → 409 DUPLICATE_RESOURCE', () => {
    it('R14 — echoes ONLY field names, never the raw collided values', () => {
        // The R14 defence: a duplicate-token error includes the raw token
        // value in `keyValue.token`. Echoing it back leaks a server-minted
        // refresh token / reset token to whoever submitted the request.
        // Same shape for synthetic GDPR emails on the user-erase path.
        const err = {
            code: 11000,
            keyPattern: { token: 1 },
            keyValue: { token: 'rt_LIVE-secret-do-not-leak' },
        };
        const res = mockResponse();
        globalErrorHandler(err as unknown as Error, mockReq(), res, mockNext);

        expect(res.status).toHaveBeenCalledWith(409);
        const body = lastJsonPayload(res);
        expect(body.error.code).toBe(ERROR_CODES.DUPLICATE_RESOURCE);
        // Field name only.
        expect((body.error.details as { fields: string[] }).fields).toEqual(['token']);
        // The raw value MUST NOT appear anywhere in the response.
        const serialised = JSON.stringify(body);
        expect(serialised).not.toContain('rt_LIVE-secret-do-not-leak');
    });

    it('falls back to keyPattern when keyValue is absent', () => {
        const err = { code: 11000, keyPattern: { email: 1 } };
        const res = mockResponse();
        globalErrorHandler(err as unknown as Error, mockReq(), res, mockNext);

        const body = lastJsonPayload(res);
        expect((body.error.details as { fields: string[] }).fields).toEqual(['email']);
    });
});

describe('Unhandled error fallback', () => {
    it('returns 500 INTERNAL_ERROR for a generic Error', () => {
        const err = new Error('unexpected boom');
        const res = mockResponse();
        globalErrorHandler(err, mockReq(), res, mockNext);

        expect(res.status).toHaveBeenCalledWith(500);
        const body = lastJsonPayload(res);
        expect(body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
        // In tests NODE_ENV !== 'production' → original message comes through
        // for debugging. Production behaviour (genericised message) is gated
        // on NODE_ENV and exercised in integration tests with the real env.
        expect(body.error.message).toBe('unexpected boom');
    });

    it('falls back to "Unknown error" when the error has no message', () => {
        const err = new Error('');
        const res = mockResponse();
        globalErrorHandler(err, mockReq(), res, mockNext);

        const body = lastJsonPayload(res);
        expect(body.error.message).toBe('Unknown error');
    });
});

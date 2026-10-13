import { describe, expect, it } from 'vitest';

import { AppError } from './app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * `AppError` is the canonical thrown error throughout the codebase.
 * Every static factory pins a (statusCode, code) pair that the global
 * error handler relies on. This file locks in those pairings so a
 * regression that, say, made `forbidden()` return 401 instead of 403
 * surfaces immediately.
 *
 * What we lock in:
 *   1. Each factory produces an `AppError` instance (instanceof check —
 *      important because the error handler dispatches on it).
 *   2. Each factory's status-code + canonical-error-code pair matches
 *      the API_Contract §1.5 mapping.
 *   3. The constructor passes `details` through verbatim to the
 *      thrown instance — the global handler unwraps `details` for
 *      the JSON body.
 *   4. `instanceof Error` still holds (the prototype-chain fix in the
 *      constructor — without it, `err instanceof AppError` would be
 *      false in some bundler configurations).
 */

describe('AppError construction + identity', () => {
    it('is an Error subclass with the AppError name', () => {
        const err = AppError.forbidden();
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(AppError);
        expect(err.name).toBe('AppError');
    });

    it('passes message + statusCode + code + details through to the instance', () => {
        const err = new AppError({
            statusCode: 418,
            code: ERROR_CODES.VALIDATION_ERROR,
            message: 'I am a teapot',
            details: { reason: 'short and stout' },
        });
        expect(err.message).toBe('I am a teapot');
        expect(err.statusCode).toBe(418);
        expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        expect(err.details).toEqual({ reason: 'short and stout' });
    });
});

describe('400 / 401 / 403 / 404 / 409 / 410 / 422 / 423 / 500 factories', () => {
    /**
     * Pin the (statusCode, code) pair for each factory. The error handler's
     * downstream contract (`res.status(err.statusCode).json({error: {code: err.code, ...}})`)
     * means a regression in either field changes both the HTTP semantic and
     * the FE's switch-on-code branching.
     */
    it.each([
        ['validation', AppError.validation, 400, ERROR_CODES.VALIDATION_ERROR],
        ['unauthenticated', AppError.unauthenticated, 401, ERROR_CODES.UNAUTHENTICATED],
        ['invalidCredentials', AppError.invalidCredentials, 401, ERROR_CODES.INVALID_CREDENTIALS],
        ['tokenExpired', AppError.tokenExpired, 401, ERROR_CODES.TOKEN_EXPIRED],
        ['forbidden', AppError.forbidden, 403, ERROR_CODES.FORBIDDEN],
        ['notFound', AppError.notFound, 404, ERROR_CODES.RESOURCE_NOT_FOUND],
        ['accountLocked', AppError.accountLocked, 423, ERROR_CODES.ACCOUNT_LOCKED],
        ['internal', AppError.internal, 500, ERROR_CODES.INTERNAL_ERROR],
    ])('%s() → status %s + code %s', (_name, factory, expectedStatus, expectedCode) => {
        const err = (factory as () => AppError)();
        expect(err.statusCode).toBe(expectedStatus);
        expect(err.code).toBe(expectedCode);
    });

    it('conflict() defaults to DUPLICATE_RESOURCE but accepts a specific code', () => {
        // Several services use conflict() with a domain-specific code
        // (ADMIN_ALREADY_EXISTS, EMAIL_ALREADY_EXISTS, ...). Pin both forms.
        const def = AppError.conflict('something already exists');
        expect(def.statusCode).toBe(409);
        expect(def.code).toBe(ERROR_CODES.DUPLICATE_RESOURCE);

        const specific = AppError.conflict('email taken', ERROR_CODES.EMAIL_ALREADY_EXISTS);
        expect(specific.code).toBe(ERROR_CODES.EMAIL_ALREADY_EXISTS);
    });

    it('gone() and unprocessable() both require an explicit code (no default)', () => {
        // These are 410 / 422 respectively. The code is intentionally
        // required because there's no single canonical choice — a share
        // link gone is different from a one-time token gone.
        const gone = AppError.gone('share link revoked', ERROR_CODES.SHARE_LINK_REVOKED, { revoked_at: '...' });
        expect(gone.statusCode).toBe(410);
        expect(gone.code).toBe(ERROR_CODES.SHARE_LINK_REVOKED);
        expect(gone.details).toEqual({ revoked_at: '...' });

        const unp = AppError.unprocessable('SL date invalid', ERROR_CODES.SPRINT_DATE_INVALID, { what: 'why' });
        expect(unp.statusCode).toBe(422);
        expect(unp.code).toBe(ERROR_CODES.SPRINT_DATE_INVALID);
        expect(unp.details).toEqual({ what: 'why' });
    });

    it('badRequest() defaults to VALIDATION_ERROR but accepts overrides', () => {
        const def = AppError.badRequest('bad shape');
        expect(def.statusCode).toBe(400);
        expect(def.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
});

describe('details pass-through', () => {
    it('factories that accept details thread them onto the instance', () => {
        const err = AppError.validation('failed', { fields: ['email'] });
        expect(err.details).toEqual({ fields: ['email'] });
    });

    it('factories that DO NOT accept details leave the field undefined', () => {
        // forbidden / notFound / unauthenticated / invalidCredentials /
        // tokenExpired / accountLocked / internal — none accept details
        // by design. Pin that the field is undefined (the global handler
        // omits the JSON key entirely when undefined; the test in
        // error-handler.middleware.test.ts pins the omission).
        expect(AppError.forbidden().details).toBeUndefined();
        expect(AppError.notFound().details).toBeUndefined();
        expect(AppError.internal().details).toBeUndefined();
    });
});

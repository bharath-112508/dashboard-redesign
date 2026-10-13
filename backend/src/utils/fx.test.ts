import { describe, expect, it } from 'vitest';

import { toReportingCurrency } from './fx.js';
import { AppError } from './app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';

describe('toReportingCurrency', () => {
    it('converts using the matching fx rate', () => {
        expect(toReportingCurrency(100, 'EUR', 'INR', [{ currency: 'EUR', rate_to_base: 90 }])).toBe(9000);
    });

    it('returns the amount unchanged when fromCurrency === reportingCurrency', () => {
        expect(toReportingCurrency(100, 'INR', 'INR', [])).toBe(100);
    });

    it('matches currency case-insensitively, both on the rate lookup and the same-currency short-circuit', () => {
        expect(toReportingCurrency(100, 'eur', 'INR', [{ currency: 'EUR', rate_to_base: 90 }])).toBe(9000);
        expect(toReportingCurrency(100, 'inr', 'INR', [])).toBe(100);
    });

    it('throws an AppError with FX_RATE_MISSING when no matching rate exists', () => {
        expect(() => toReportingCurrency(100, 'EUR', 'INR', [])).toThrow(AppError);
        try {
            toReportingCurrency(100, 'EUR', 'INR', [{ currency: 'GBP', rate_to_base: 100 }]);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).code).toBe(ERROR_CODES.FX_RATE_MISSING);
            expect((err as AppError).statusCode).toBe(422);
        }
    });
});

import { AppError } from './app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * Billing Phase 2 — FX conversion into the org's reporting currency.
 * Consumed by the Margin report (a later task) to normalise per-person
 * cost rates (which may be quoted in any currency) into
 * `SystemSettings.billing.reporting_currency` before comparing against
 * billed amounts.
 */
export interface FxRate {
    currency: string;
    rate_to_base: number;
}

/**
 * Converts `amount` from `fromCurrency` into `reportingCurrency`.
 *
 * - Same currency (case-insensitive) — returned unchanged, no rate lookup.
 * - Otherwise looks up a case-insensitive match on `fxRates[].currency` and
 *   multiplies `amount * rate_to_base`.
 * - No matching rate — throws `AppError` (422, `FX_RATE_MISSING`) so the
 *   caller (Margin report) can surface a clear "configure this rate" error
 *   rather than silently mis-reporting.
 */
export const toReportingCurrency = (
    amount: number,
    fromCurrency: string,
    reportingCurrency: string,
    fxRates: FxRate[]
): number => {
    const from = (fromCurrency || '').toUpperCase();
    const base = (reportingCurrency || '').toUpperCase();

    if (from === base) return amount;

    const hit = fxRates.find((rate) => rate.currency.toUpperCase() === from);
    if (!hit) {
        throw AppError.unprocessable(`Missing FX rate for ${from} → ${base}`, ERROR_CODES.FX_RATE_MISSING);
    }

    return amount * hit.rate_to_base;
};

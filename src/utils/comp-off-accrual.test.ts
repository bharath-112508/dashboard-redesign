import { describe, expect, it } from 'vitest';

import { overtimeBank, weekendGrantDays } from './comp-off-accrual.js';

const FULL = 480; // 8h shift

describe('weekendGrantDays', () => {
    it('grants a full day at or above the full shift', () => {
        expect(weekendGrantDays(FULL, FULL)).toBe(1);
        expect(weekendGrantDays(FULL + 120, FULL)).toBe(1);
    });

    it('grants half a day at or above half the shift (but under full)', () => {
        expect(weekendGrantDays(FULL / 2, FULL)).toBe(0.5);
        expect(weekendGrantDays(FULL - 1, FULL)).toBe(0.5);
    });

    it('grants nothing below half a shift', () => {
        expect(weekendGrantDays(FULL / 2 - 1, FULL)).toBe(0);
        expect(weekendGrantDays(0, FULL)).toBe(0);
    });

    it('is safe for degenerate inputs', () => {
        expect(weekendGrantDays(600, 0)).toBe(0);
        expect(weekendGrantDays(-30, FULL)).toBe(0);
    });
});

describe('overtimeBank', () => {
    it('converts a full threshold and empties the carry', () => {
        expect(overtimeBank(0, 480, FULL)).toEqual({ grantDays: 1, newBankMinutes: 0 });
    });

    it('accumulates across days and carries the remainder', () => {
        // 200 banked + 300 today = 500 → 1 comp-off, 20 carried
        expect(overtimeBank(200, 300, FULL)).toEqual({ grantDays: 1, newBankMinutes: 20 });
    });

    it('grants multiple days when the bank crosses several thresholds', () => {
        // 0 + 1000 = 1000 → 2 comp-off (960), 40 carried
        expect(overtimeBank(0, 1000, FULL)).toEqual({ grantDays: 2, newBankMinutes: 40 });
    });

    it('banks sub-threshold overtime without granting', () => {
        expect(overtimeBank(0, 100, FULL)).toEqual({ grantDays: 0, newBankMinutes: 100 });
        expect(overtimeBank(100, 379, FULL)).toEqual({ grantDays: 0, newBankMinutes: 479 });
    });

    it('is safe for degenerate inputs', () => {
        expect(overtimeBank(50, 0, 0)).toEqual({ grantDays: 0, newBankMinutes: 50 });
        expect(overtimeBank(-10, 480, FULL)).toEqual({ grantDays: 1, newBankMinutes: 0 });
    });
});

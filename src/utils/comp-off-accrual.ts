/**
 * Pure rule engine for automatic comp-off accrual.
 * See docs/superpowers/specs/2026-07-21-comp-off-auto-accrual-design.md.
 *
 * Two independent rules, chosen per day by the caller:
 *  - weekend/holiday work → {@link weekendGrantDays}
 *  - normal-working-day overtime → {@link overtimeBank}
 *
 * Both are side-effect-free so they can be exhaustively unit-tested.
 */

/**
 * Comp-off earned for working a weekend or holiday, by worked minutes against
 * the scheduled full shift: a full shift = 1 day, half a shift = 0.5, less
 * than half = nothing.
 */
export const weekendGrantDays = (workedMinutes: number, fullShiftMinutes: number): 0 | 0.5 | 1 => {
    if (fullShiftMinutes <= 0 || workedMinutes <= 0) return 0;
    if (workedMinutes >= fullShiftMinutes) return 1;
    if (workedMinutes >= fullShiftMinutes / 2) return 0.5;
    return 0;
};

/**
 * Add a working day's overtime to the running bank and convert whole
 * thresholds into comp-off days, carrying the remainder forward.
 *
 * e.g. bank 200 + 300 more, threshold 480 → grant 1, 20 left in the bank.
 */
export const overtimeBank = (
    bankMinutes: number,
    addMinutes: number,
    thresholdMinutes: number
): { grantDays: number; newBankMinutes: number } => {
    const safeBank = Math.max(0, bankMinutes);
    if (thresholdMinutes <= 0) return { grantDays: 0, newBankMinutes: safeBank };
    const total = safeBank + Math.max(0, addMinutes);
    const grantDays = Math.floor(total / thresholdMinutes);
    const newBankMinutes = total - grantDays * thresholdMinutes;
    return { grantDays, newBankMinutes };
};

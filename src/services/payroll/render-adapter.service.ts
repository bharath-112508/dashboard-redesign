import type { Types } from 'mongoose';

import { User } from '../../models/user.model.js';
import { PayrollProfile } from '../../models/payroll-profile.model.js';
import { getCurrentStructure } from '../salary-structure.service.js';
import { getOrInitSettings } from '../settings.service.js';
import { AppError } from '../../utils/app-error.js';
import { ERROR_CODES } from '../../constants/error-codes.js';
import dayjs, { DATE_FORMAT } from '../../utils/date.js';
import type { PayslipRenderData } from './payslip-template.js';
import type { LetterRenderData, LetterType } from './letter-template.js';

/**
 * Render-data adapter (Task 6) — maps platform models (User, PayrollProfile,
 * SalaryStructure, SystemSettings) into the render-data shapes consumed by
 * the ported PDF templates (`payslip-template.ts`, `letter-template.ts`).
 *
 * Pure read/transform: no `req`/HTTP concerns, no audit rows (nothing is
 * mutated here). Callers (payslip/letter generation services, Tasks 7 & 8)
 * own the audit trail for the actual document-generation act.
 */

// ─── Company block (shared by payslip + every letter type) ────────────────

export interface CompanyBlock {
    companyName: string;
    companyAddress: string[];
    companyEmail: string;
    cinNo: string;
    iecCode: string;
    signatoryName: string;
    signatoryTitle: string;
}

/**
 * Reads the singleton `SystemSettings.payroll` subsection and maps it to the
 * company/signatory block shared across payslip + letter templates.
 *
 * NOTE on the settings accessor: the brief's sketch test mocks a `getSettings`
 * export from `settings.service.js`, but no such export exists on the real
 * service. The singleton read/lazy-seed accessor there is `getOrInitSettings`
 * (returns the live `SystemSettingsDocument`, seeding `DEFAULT_SETTINGS` on
 * first read) — that's the one used here.
 */
export const getCompanyBlock = async (): Promise<CompanyBlock> => {
    const settings = await getOrInitSettings();
    const payroll = settings.payroll;
    return {
        companyName: payroll.company_legal_name,
        companyAddress: payroll.company_address_lines,
        companyEmail: payroll.company_email,
        cinNo: payroll.cin_no,
        iecCode: payroll.iec_code,
        signatoryName: payroll.signatory_name,
        signatoryTitle: payroll.signatory_title,
    };
};

// ─── Shared employee lookup ─────────────────────────────────────────────

interface EmployeeCore {
    employeeName: string;
    employeeNumber: string;
    designation: string;
    department: string;
    dateOfJoining: string;
}

/** Render-facing date format for payslips/letters, e.g. `2-Mar-2022`. */
const RENDER_DATE_FORMAT = 'D-MMM-YYYY';

/**
 * Formats a stored `YYYY-MM-DD` date (e.g. `User.internal_profile.date_of_joining`)
 * into the `D-MMM-YYYY` shape the payslip/letter templates render (matches the
 * reference samples, e.g. `2-Mar-2022`). Falls back to the raw input — never
 * throws, never emits "Invalid Date" — when the value is empty/falsy or dayjs
 * can't parse it.
 */
export const formatRenderDate = (value: string | undefined | null): string => {
    if (!value) return value ?? '';
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed.format(RENDER_DATE_FORMAT) : value;
};

/**
 * Resolves the render-facing "date of joining" string: an admin-entered
 * `PayrollProfile.date_of_joining_override` wins over the User record's
 * `internal_profile.date_of_joining` when non-empty. The override is run
 * through the same `D-MMM-YYYY` formatting as the user-record value when it
 * parses as a date; if it's set but not parseable (e.g. free text), it's used
 * as-is rather than discarded. With no override, the already-formatted
 * fallback (`employeeDateOfJoining`) is returned unchanged.
 */
const resolveDateOfJoining = (override: string | undefined | null, employeeDateOfJoining: string): string => {
    if (!override) return employeeDateOfJoining;
    return formatRenderDate(override);
};

const loadEmployeeCore = async (userId: Types.ObjectId): Promise<EmployeeCore> => {
    const user = await User.findById(userId).lean();
    if (!user) throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);

    const profile = user.internal_profile;
    return {
        employeeName: user.full_name,
        employeeNumber: profile?.employee_id ?? '',
        designation: profile?.job_title ?? '',
        department: profile?.department ?? '',
        dateOfJoining: formatRenderDate(profile?.date_of_joining),
    };
};

// ─── Payslip ────────────────────────────────────────────────────────────

/**
 * Builds the full render-data payload for a payslip PDF.
 *
 * `payPeriod` and `daysPresent` are caller-supplied (payroll-run inputs, not
 * derived from a model here). `effectiveOn` pins which `SalaryStructure` row
 * applies (`getCurrentStructure` re-derives from `effective_from`, not the
 * denormalized `is_current` flag).
 */
export const buildPayslipRenderData = async (
    userId: Types.ObjectId,
    payPeriod: string,
    daysPresent: number,
    effectiveOn: string
): Promise<PayslipRenderData> => {
    const [employee, profileDoc, structure, company] = await Promise.all([
        loadEmployeeCore(userId),
        PayrollProfile.findOne({ user_id: userId }).lean(),
        getCurrentStructure(userId, effectiveOn),
        getCompanyBlock(),
    ]);

    // No PayrollProfile row yet — the payslip still renders, just with blank
    // statutory/bank fields rather than 404ing.
    const profile = profileDoc ?? {
        pan: '',
        uan: '',
        pf_account_number: '',
        esi_number: '',
        pran_number: '',
        bank_details: '',
        location: '',
        tax_regime: '',
        function_override: '',
        designation_override: '',
        date_of_joining_override: '',
    };

    return {
        companyName: company.companyName,
        companyAddress: company.companyAddress,
        companyEmail: company.companyEmail,
        cinNo: company.cinNo,
        iecCode: company.iecCode,

        payPeriod,

        employeeName: employee.employeeName,
        employeeNumber: employee.employeeNumber,
        function: profile.function_override || employee.department,
        designation: profile.designation_override || employee.designation,
        location: profile.location ?? '',
        bankDetails: profile.bank_details,
        dateOfJoining: resolveDateOfJoining(profile.date_of_joining_override, employee.dateOfJoining),
        taxRegime: profile.tax_regime,
        pan: profile.pan,
        uan: profile.uan,
        pfAccountNumber: profile.pf_account_number,
        esiNumber: profile.esi_number,
        pranNumber: profile.pran_number,
        daysPresent,
        earnings: structure.earnings,
        deductions: structure.deductions,
    };
};

// ─── Letters (relieving / experience / internship / hike / promotion) ────

/** Caller-supplied fields the adapter cannot derive from the platform models
 * (dates, references, body copy, etc.) plus any derived-default override. */
export type LetterRenderDataOverrides = Partial<LetterRenderData>;

const sumEarnings = (structure: { earnings: { amount: number }[] }): number =>
    structure.earnings.reduce((acc, e) => acc + (Number.isFinite(e.amount) ? e.amount : 0), 0);

/**
 * Hike/promotion "previous vs new" CTC.
 *
 * `SalaryStructure` rows store MONTHLY amounts (Task 5). The letter template
 * renders an ANNUAL CTC (sample letter shows "₹ 9,00,000 p.a." for a monthly
 * figure of ₹75,000), so both the current and prior structure's earnings sum
 * is multiplied by 12 here before being placed on `newCtc`/`previousCtc`.
 *
 * "Previous" is the row immediately before the current one, i.e. the next-
 * newest `effective_from` strictly before the current row's. If none exists
 * (the employee has only ever had one structure), `previousCtc` is left
 * `undefined` so the template's own defaults take over — NOT zeroed, which
 * would misleadingly render "previous CTC: ₹0".
 */
const deriveHikePromotionFields = async (
    userId: Types.ObjectId,
    effectiveOn: string | undefined
): Promise<Pick<LetterRenderData, 'newCtc' | 'previousCtc'>> => {
    const current = await getCurrentStructure(userId, effectiveOn);
    const newCtc = sumEarnings(current) * 12;

    // The row immediately before `current` — one day earlier than its
    // `effective_from` — is the "previous" structure. No row → no previousCtc.
    let previousCtc: number | undefined;
    try {
        const dayBeforeCurrent = dayjs(current.effective_from).subtract(1, 'day').format(DATE_FORMAT);
        const previous = await getCurrentStructure(userId, dayBeforeCurrent);
        previousCtc = sumEarnings(previous) * 12;
    } catch (err) {
        if (err instanceof AppError && err.code === ERROR_CODES.PAYROLL_NO_CURRENT_SALARY) {
            // No prior structure — leave previousCtc undefined; the template
            // supplies its own default.
            previousCtc = undefined;
        } else {
            throw err;
        }
    }

    return { newCtc, previousCtc };
};

const HIKE_PROMOTION_TYPES: ReadonlySet<LetterType> = new Set(['hike', 'promotion']);

/**
 * Builds the render-data payload for a letter PDF (relieving / experience /
 * internship / hike / promotion). Employee + company fields are derived from
 * the platform models; everything the adapter cannot know (issue date,
 * reference, last working day, body copy, etc.) comes from `overrides` —
 * which also wins over any derived default the adapter computes, so a caller
 * can always hand-correct a field.
 */
export const buildLetterRenderData = async (
    userId: Types.ObjectId,
    type: LetterType,
    overrides: LetterRenderDataOverrides = {}
): Promise<LetterRenderData> => {
    const [employee, company, profile] = await Promise.all([
        loadEmployeeCore(userId),
        getCompanyBlock(),
        PayrollProfile.findOne({ user_id: userId }).lean(),
    ]);

    const derivedCtc = HIKE_PROMOTION_TYPES.has(type)
        ? await deriveHikePromotionFields(userId, overrides.effectiveDate)
        : {};

    // Dates arrive as canonical `YYYY-MM-DD` (validated on the way in and used
    // raw for the CTC derivation above); format them for display so the template
    // prints `6-May-2026` rather than `2026-05-06`. Overlaid after `...overrides`.
    const displayDates: LetterRenderDataOverrides = {};
    if (overrides.issueDate) displayDates.issueDate = formatRenderDate(overrides.issueDate);
    if (overrides.lastWorkingDay) displayDates.lastWorkingDay = formatRenderDate(overrides.lastWorkingDay);
    if (overrides.effectiveDate) displayDates.effectiveDate = formatRenderDate(overrides.effectiveDate);

    return {
        companyName: company.companyName,
        companyAddress: company.companyAddress,
        companyEmail: company.companyEmail,
        cinNo: company.cinNo,
        iecCode: company.iecCode,

        type,
        issueDate: '',

        employeeName: employee.employeeName,
        employeeNumber: employee.employeeNumber,
        designation: profile?.designation_override || employee.designation,
        department: employee.department,
        location: overrides.location ?? profile?.location ?? '',
        dateOfJoining: resolveDateOfJoining(profile?.date_of_joining_override, employee.dateOfJoining),
        lastWorkingDay: '',

        signatoryName: company.signatoryName,
        signatoryTitle: company.signatoryTitle,

        ...derivedCtc,
        ...overrides,
        ...displayDates,
    };
};

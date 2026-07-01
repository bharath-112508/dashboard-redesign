import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/user.model.js', () => ({ User: { findById: vi.fn() } }));
vi.mock('../../models/payroll-profile.model.js', () => ({ PayrollProfile: { findOne: vi.fn() } }));
vi.mock('../salary-structure.service.js', () => ({ getCurrentStructure: vi.fn() }));
// NOTE: the brief's sketch mocks a `getSettings` export from settings.service.js,
// but that export doesn't exist on the real service — the singleton read/seed
// accessor is `getOrInitSettings` (see src/services/settings.service.ts). Mocking
// the real name here.
vi.mock('../settings.service.js', () => ({ getOrInitSettings: vi.fn() }));

import { Types } from 'mongoose';
import { User } from '../../models/user.model.js';
import { PayrollProfile } from '../../models/payroll-profile.model.js';
import { getCurrentStructure } from '../salary-structure.service.js';
import { getOrInitSettings } from '../settings.service.js';
import { AppError } from '../../utils/app-error.js';
import { ERROR_CODES } from '../../constants/error-codes.js';
import { buildPayslipRenderData, buildLetterRenderData, getCompanyBlock } from './render-adapter.service.js';

beforeEach(() => {
    vi.clearAllMocks();
    (PayrollProfile.findOne as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        lean: () => Promise.resolve(null),
    });
});

const mockSettings = () =>
    (getOrInitSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        payroll: {
            company_legal_name: 'M/S VILJA TECH LABS PRIVATE LIMITED',
            company_address_lines: ['Hyderabad'],
            company_email: 'hr@viljetech.com',
            cin_no: 'CIN',
            iec_code: 'IEC',
            signatory_name: 'S',
            signatory_title: 'HR',
        },
    });

describe('buildPayslipRenderData', () => {
    it('maps platform models into PayslipRenderData', async () => {
        (User.findById as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            lean: () =>
                Promise.resolve({
                    full_name: 'Gorrela Krishna Kumar',
                    internal_profile: {
                        employee_id: 'VT04',
                        job_title: 'Sr.FullStack Developer',
                        department: 'Software Developer',
                        date_of_joining: '2022-03-02',
                    },
                }),
        });
        (PayrollProfile.findOne as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            lean: () =>
                Promise.resolve({
                    pan: 'CZQPG6515F',
                    uan: '102245544157',
                    pf_account_number: '-',
                    esi_number: '-',
                    pran_number: '-',
                    bank_details: 'HDFC',
                    location: 'Hyderabad',
                    tax_regime: 'Regular Tax Regime',
                }),
        });
        (getCurrentStructure as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            earnings: [{ label: 'Basic Pay', amount: 37500 }],
            deductions: [{ label: 'Professional Tax', amount: 200 }],
        });
        mockSettings();

        const d = await buildPayslipRenderData(new Types.ObjectId(), 'February-2026', 22, '2026-02-28');
        expect(d.employeeName).toBe('Gorrela Krishna Kumar');
        expect(d.employeeNumber).toBe('VT04');
        expect(d.designation).toBe('Sr.FullStack Developer');
        expect(d.function).toBe('Software Developer');
        expect(d.dateOfJoining).toBe('2-Mar-2022');
        expect(d.pan).toBe('CZQPG6515F');
        // ^ formatted from the stored `2022-03-02` (YYYY-MM-DD) via dayjs 'D-MMM-YYYY'.
        expect(d.uan).toBe('102245544157');
        expect(d.pfAccountNumber).toBe('-');
        expect(d.esiNumber).toBe('-');
        expect(d.pranNumber).toBe('-');
        expect(d.bankDetails).toBe('HDFC');
        expect(d.location).toBe('Hyderabad');
        expect(d.taxRegime).toBe('Regular Tax Regime');
        expect(d.payPeriod).toBe('February-2026');
        expect(d.daysPresent).toBe(22);
        expect(d.earnings).toEqual([{ label: 'Basic Pay', amount: 37500 }]);
        expect(d.deductions).toEqual([{ label: 'Professional Tax', amount: 200 }]);
        expect(d.companyName).toBe('M/S VILJA TECH LABS PRIVATE LIMITED');
        expect(d.companyAddress).toEqual(['Hyderabad']);
        expect(d.companyEmail).toBe('hr@viljetech.com');
        expect(d.cinNo).toBe('CIN');
        expect(d.iecCode).toBe('IEC');
    });

    it('defaults PayrollProfile fields to empty strings when no profile row exists', async () => {
        (User.findById as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            lean: () =>
                Promise.resolve({
                    full_name: 'No Profile User',
                    internal_profile: {
                        employee_id: 'VT99',
                        job_title: 'Engineer',
                        department: 'Engineering',
                        date_of_joining: '2024-01-01',
                    },
                }),
        });
        (PayrollProfile.findOne as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            lean: () => Promise.resolve(null),
        });
        (getCurrentStructure as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            earnings: [],
            deductions: [],
        });
        mockSettings();

        const d = await buildPayslipRenderData(new Types.ObjectId(), 'March-2026', 20, '2026-03-31');
        expect(d.pan).toBe('');
        expect(d.uan).toBe('');
        expect(d.pfAccountNumber).toBe('');
        expect(d.esiNumber).toBe('');
        expect(d.pranNumber).toBe('');
        expect(d.bankDetails).toBe('');
        expect(d.taxRegime).toBe('');
    });

    it('throws USER_NOT_FOUND when the user does not exist', async () => {
        (User.findById as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            lean: () => Promise.resolve(null),
        });
        (PayrollProfile.findOne as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            lean: () => Promise.resolve(null),
        });
        (getCurrentStructure as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            earnings: [],
            deductions: [],
        });
        mockSettings();

        await expect(
            buildPayslipRenderData(new Types.ObjectId(), 'March-2026', 20, '2026-03-31')
        ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });

    it('formats a stored YYYY-MM-DD date_of_joining to D-MMM-YYYY', async () => {
        (User.findById as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            lean: () =>
                Promise.resolve({
                    full_name: 'Date Format User',
                    internal_profile: {
                        employee_id: 'VT55',
                        job_title: 'Engineer',
                        department: 'Engineering',
                        date_of_joining: '2022-03-02',
                    },
                }),
        });
        (getCurrentStructure as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            earnings: [],
            deductions: [],
        });
        mockSettings();

        const d = await buildPayslipRenderData(new Types.ObjectId(), 'March-2026', 20, '2026-03-31');
        expect(d.dateOfJoining).toBe('2-Mar-2022');
    });

    it('falls back to the raw value instead of throwing/"Invalid Date" when date_of_joining is blank', async () => {
        (User.findById as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            lean: () =>
                Promise.resolve({
                    full_name: 'Blank Date User',
                    internal_profile: {
                        employee_id: 'VT56',
                        job_title: 'Engineer',
                        department: 'Engineering',
                        date_of_joining: '',
                    },
                }),
        });
        (getCurrentStructure as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            earnings: [],
            deductions: [],
        });
        mockSettings();

        const d = await buildPayslipRenderData(new Types.ObjectId(), 'March-2026', 20, '2026-03-31');
        expect(d.dateOfJoining).toBe('');
        expect(d.dateOfJoining).not.toMatch(/invalid/i);
    });
});

describe('getCompanyBlock', () => {
    it('maps SystemSettings.payroll into the company block shape', async () => {
        mockSettings();
        const block = await getCompanyBlock();
        expect(block).toEqual({
            companyName: 'M/S VILJA TECH LABS PRIVATE LIMITED',
            companyAddress: ['Hyderabad'],
            companyEmail: 'hr@viljetech.com',
            cinNo: 'CIN',
            iecCode: 'IEC',
            signatoryName: 'S',
            signatoryTitle: 'HR',
        });
    });
});

describe('buildLetterRenderData', () => {
    const setUser = () =>
        (User.findById as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            lean: () =>
                Promise.resolve({
                    full_name: 'Priya Sharma',
                    internal_profile: {
                        employee_id: 'VT10',
                        job_title: 'Senior Engineer',
                        department: 'Engineering',
                        date_of_joining: '2020-04-01',
                    },
                }),
        });

    it('builds a relieving letter without touching salary structures', async () => {
        setUser();
        mockSettings();

        const d = await buildLetterRenderData(new Types.ObjectId(), 'relieving', { lastWorkingDay: '2026-06-30' });
        expect(d.type).toBe('relieving');
        expect(d.employeeName).toBe('Priya Sharma');
        expect(d.employeeNumber).toBe('VT10');
        expect(d.designation).toBe('Senior Engineer');
        expect(d.department).toBe('Engineering');
        expect(d.dateOfJoining).toBe('1-Apr-2020');
        // ^ formatted from the stored `2020-04-01` (YYYY-MM-DD) via dayjs 'D-MMM-YYYY'.
        expect(d.lastWorkingDay).toBe('2026-06-30');
        expect(d.companyName).toBe('M/S VILJA TECH LABS PRIVATE LIMITED');
        expect(getCurrentStructure).not.toHaveBeenCalled();
    });

    it('annualizes current monthly earnings into newCtc for a hike letter, with previousCtc from the prior structure', async () => {
        setUser();
        mockSettings();
        (getCurrentStructure as unknown as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({
                effective_from: '2026-04-01',
                earnings: [{ label: 'Basic Pay', amount: 75000 }],
                deductions: [],
            })
            .mockResolvedValueOnce({
                effective_from: '2025-04-01',
                earnings: [{ label: 'Basic Pay', amount: 60000 }],
                deductions: [],
            });

        const d = await buildLetterRenderData(new Types.ObjectId(), 'hike', { effectiveDate: '2026-04-01' });
        expect(d.type).toBe('hike');
        expect(d.newCtc).toBe(75000 * 12);
        expect(d.previousCtc).toBe(60000 * 12);
    });

    it('leaves previousCtc undefined when there is no prior structure', async () => {
        setUser();
        mockSettings();
        (getCurrentStructure as unknown as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({
                effective_from: '2026-04-01',
                earnings: [{ label: 'Basic Pay', amount: 75000 }],
                deductions: [],
            })
            .mockRejectedValueOnce(
                AppError.notFound('No salary structure on or before this date', ERROR_CODES.PAYROLL_NO_CURRENT_SALARY)
            );

        const d = await buildLetterRenderData(new Types.ObjectId(), 'promotion', { effectiveDate: '2026-04-01' });
        expect(d.newCtc).toBe(75000 * 12);
        expect(d.previousCtc).toBeUndefined();
    });

    it('propagates a non-not-found error from the prior-structure lookup instead of swallowing it', async () => {
        setUser();
        mockSettings();
        (getCurrentStructure as unknown as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({
                effective_from: '2026-04-01',
                earnings: [{ label: 'Basic Pay', amount: 75000 }],
                deductions: [],
            })
            .mockRejectedValueOnce(new Error('DB connection lost'));

        await expect(
            buildLetterRenderData(new Types.ObjectId(), 'promotion', { effectiveDate: '2026-04-01' })
        ).rejects.toThrow('DB connection lost');
    });

    it('lets caller overrides win over derived defaults', async () => {
        setUser();
        mockSettings();

        const d = await buildLetterRenderData(new Types.ObjectId(), 'experience', {
            lastWorkingDay: '2026-06-30',
            designation: 'Overridden Title',
        });
        expect(d.designation).toBe('Overridden Title');
    });
});

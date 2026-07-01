import { describe, it, expect, afterAll } from 'vitest';
import { htmlToPdf, shutdownPdf } from './pdf.service.js';
import { renderPayslipHtmlFromData, payslipNetPayFromData, type PayslipRenderData } from './payslip-template.js';

const SAMPLE: PayslipRenderData = {
    companyName: 'M/S VILJA TECH LABS PRIVATE LIMITED',
    companyAddress: ['Flat No: 103', 'Pragathi Nagar, Hyderabad'],
    companyEmail: 'hr@viljetech.com',
    cinNo: 'U72200TG2021PTC150430',
    iecCode: 'AAICV0090N',
    payPeriod: 'February-2026',
    employeeName: 'Gorrela Krishna Kumar',
    employeeNumber: 'VT04',
    function: 'Software Developer',
    designation: 'Sr.FullStack Developer',
    location: 'Hyderabad',
    bankDetails: 'HDFC',
    dateOfJoining: '2-Mar-2022',
    taxRegime: 'Regular Tax Regime',
    pan: 'CZQPG6515F',
    uan: '102245544157',
    pfAccountNumber: '-',
    esiNumber: '-',
    pranNumber: '-',
    daysPresent: 22,
    earnings: [
        { label: 'Basic Pay', amount: 37500 },
        { label: 'House Rent Allowance', amount: 15000 },
        { label: 'Leave Travel Allowance', amount: 3000 },
        { label: 'Others', amount: 7250 },
        { label: 'Variable Pay', amount: 12250 },
    ],
    deductions: [
        { label: "Employee's PF Contribution @ 12%", amount: 1800 },
        { label: 'Professional Tax', amount: 200 },
        { label: 'Insurance', amount: 869 },
    ],
};

afterAll(async () => { await shutdownPdf(); });

describe('payslip PDF renderer', () => {
    it('computes net pay as earnings minus deductions', () => {
        expect(payslipNetPayFromData(SAMPLE)).toBe(72131);
    });

    it('renders a non-trivial PDF buffer with a %PDF header', async () => {
        const html = renderPayslipHtmlFromData(SAMPLE);
        const pdf = await htmlToPdf(html);
        expect(pdf.length).toBeGreaterThan(10_000);
        expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }, 30_000);
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./payroll/render-adapter.service.js', () => ({ buildPayslipRenderData: vi.fn() }));
vi.mock('./payroll/payslip-template.js', () => ({
    renderPayslipHtmlFromData: vi.fn(() => '<html></html>'),
    payslipNetPayFromData: vi.fn(() => 72131),
}));
vi.mock('./payroll/pdf.service.js', () => ({ htmlToPdf: vi.fn(async () => Buffer.from('%PDF-1.7 fake')) }));
vi.mock('../utils/azure-blob.js', () => ({
    putBlob: vi.fn(async () => ({ size: 12345 })),
    mintDownloadSas: vi.fn(() => ({ url: 'https://sas', expires_at: new Date() })),
}));
vi.mock('../models/payslip.model.js', () => ({
    Payslip: { create: vi.fn(), find: vi.fn(), findById: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock('./audit.service.js', () => ({ recordAudit: vi.fn() }));

import { Types } from 'mongoose';
import { buildPayslipRenderData } from './payroll/render-adapter.service.js';
import { putBlob } from '../utils/azure-blob.js';
import { Payslip } from '../models/payslip.model.js';
import { recordAudit } from './audit.service.js';
import * as service from './payslip.service.js';

describe('payslip.service', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders, uploads, persists, and audits a payslip', async () => {
        (buildPayslipRenderData as never as ReturnType<typeof vi.fn>).mockResolvedValue({
            employeeName: 'X',
            payPeriod: 'February-2026',
        });
        const rec = { _id: new Types.ObjectId(), toJSON: () => ({ id: '1', net_pay: 72131, blob_key: 'k' }) };
        (Payslip.create as never as ReturnType<typeof vi.fn>).mockResolvedValue(rec);
        const caller = { id: new Types.ObjectId(), audit: { actor_id: new Types.ObjectId() } as never };

        const out = await service.generatePayslip(
            {
                user_id: new Types.ObjectId(),
                pay_period: 'February-2026',
                days_present: 22,
                effective_on: '2026-02-28',
            },
            caller
        );

        expect(putBlob).toHaveBeenCalledOnce();
        expect(Payslip.create).toHaveBeenCalledOnce();
        expect(recordAudit).toHaveBeenCalledOnce();
        expect(out.download_url).toBe('https://sas');
    });
});

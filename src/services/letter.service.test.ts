import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./payroll/render-adapter.service.js', () => ({
    buildLetterRenderData: vi.fn(),
    getCompanyBlock: vi.fn(),
}));
vi.mock('./payroll/letter-template.js', () => ({
    renderLetterHtml: vi.fn(() => '<html>letter</html>'),
}));
vi.mock('./payroll/offer-letter-template.js', () => ({
    renderOfferLetterHtml: vi.fn(() => '<html>offer</html>'),
}));
vi.mock('./payroll/pdf.service.js', () => ({ htmlToPdf: vi.fn(async () => Buffer.from('%PDF-1.7 fake')) }));
vi.mock('../utils/azure-blob.js', () => ({
    putBlob: vi.fn(async () => ({ size: 12345 })),
    mintDownloadSas: vi.fn(() => ({ url: 'https://sas', expires_at: new Date() })),
}));
vi.mock('../models/letter.model.js', () => ({
    Letter: { create: vi.fn(), find: vi.fn(), findById: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock('./audit.service.js', () => ({ recordAudit: vi.fn() }));

import { Types } from 'mongoose';
import { buildLetterRenderData, getCompanyBlock } from './payroll/render-adapter.service.js';
import { renderLetterHtml } from './payroll/letter-template.js';
import { renderOfferLetterHtml } from './payroll/offer-letter-template.js';
import { htmlToPdf } from './payroll/pdf.service.js';
import { putBlob } from '../utils/azure-blob.js';
import { Letter } from '../models/letter.model.js';
import { recordAudit } from './audit.service.js';
import * as service from './letter.service.js';

describe('letter.service', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders via renderLetterHtml, uploads, persists, and audits a promotion letter', async () => {
        (buildLetterRenderData as never as ReturnType<typeof vi.fn>).mockResolvedValue({
            type: 'promotion',
            employeeName: 'Priya Sharma',
            employeeNumber: 'VT10',
        });
        const rec = {
            _id: new Types.ObjectId(),
            toJSON: () => ({ id: '1', type: 'promotion', blob_key: 'k' }),
        };
        (Letter.create as never as ReturnType<typeof vi.fn>).mockResolvedValue(rec);
        const caller = { id: new Types.ObjectId(), audit: { actor_id: new Types.ObjectId() } as never };

        const out = await service.generateLetter(
            {
                type: 'promotion',
                user_id: new Types.ObjectId().toString(),
                effective_date: '2026-04-01',
                new_designation: 'Staff Engineer',
            },
            caller
        );

        expect(buildLetterRenderData).toHaveBeenCalledOnce();
        expect(renderLetterHtml).toHaveBeenCalledOnce();
        expect(putBlob).toHaveBeenCalledOnce();
        expect(Letter.create).toHaveBeenCalledOnce();
        expect(Letter.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'promotion' }));
        expect(recordAudit).toHaveBeenCalledOnce();
        const auditArg = (recordAudit as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(auditArg.action).toBe('letter.generate');
        expect(out.download_url).toBe('https://sas');
    });

    it('routes an offer letter to renderOfferLetterHtml using request-body fields, not buildLetterRenderData', async () => {
        (getCompanyBlock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            companyName: 'Vilja Tech',
            companyAddress: ['Hyderabad'],
            companyEmail: 'hr@viljetech.com',
            cinNo: 'CIN',
            iecCode: 'IEC',
            signatoryName: 'S',
            signatoryTitle: 'HR',
        });
        const rec = {
            _id: new Types.ObjectId(),
            toJSON: () => ({ id: '2', type: 'offer', blob_key: 'k2' }),
        };
        (Letter.create as never as ReturnType<typeof vi.fn>).mockResolvedValue(rec);
        const caller = { id: new Types.ObjectId(), audit: { actor_id: new Types.ObjectId() } as never };

        const out = await service.generateLetter(
            {
                type: 'offer',
                user_id: new Types.ObjectId().toString(),
                candidate_name: 'John Doe',
                designation: 'Software Engineer',
                ctc_breakdown: [{ label: 'Basic', amount: 500000 }],
            },
            caller
        );

        expect(buildLetterRenderData).not.toHaveBeenCalled();
        expect(getCompanyBlock).toHaveBeenCalledOnce();
        expect(renderOfferLetterHtml).toHaveBeenCalledOnce();
        expect(Letter.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'offer' }));
        expect(recordAudit).toHaveBeenCalledOnce();
        expect(out.download_url).toBe('https://sas');
    });

    it('previewLetter renders a promotion letter PDF without storing a blob, DB row, or audit', async () => {
        (buildLetterRenderData as never as ReturnType<typeof vi.fn>).mockResolvedValue({
            type: 'promotion',
            employeeName: 'Priya Sharma',
            employeeNumber: 'VT10',
        });

        const out = await service.previewLetter({
            type: 'promotion',
            user_id: new Types.ObjectId().toString(),
            effective_date: '2026-04-01',
            new_designation: 'Staff Engineer',
        });

        expect(buildLetterRenderData).toHaveBeenCalledOnce();
        expect(renderLetterHtml).toHaveBeenCalledOnce();
        expect(htmlToPdf).toHaveBeenCalledOnce();
        expect(typeof out.pdf_base64).toBe('string');
        expect(out.pdf_base64.length).toBeGreaterThan(0);
        expect(out.filename).toBe('Promotion_Letter_Priya_Sharma.pdf');
        expect(putBlob).not.toHaveBeenCalled();
        expect(Letter.create).not.toHaveBeenCalled();
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it('previewLetter routes an offer letter to renderOfferLetterHtml without persisting anything', async () => {
        (getCompanyBlock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            companyName: 'Vilja Tech',
            companyAddress: ['Hyderabad'],
            companyEmail: 'hr@viljetech.com',
            cinNo: 'CIN',
            iecCode: 'IEC',
            signatoryName: 'S',
            signatoryTitle: 'HR',
        });

        const out = await service.previewLetter({
            type: 'offer',
            user_id: new Types.ObjectId().toString(),
            candidate_name: 'John Doe',
            designation: 'Software Engineer',
            ctc_breakdown: [{ label: 'Basic', amount: 500000 }],
        });

        expect(buildLetterRenderData).not.toHaveBeenCalled();
        expect(getCompanyBlock).toHaveBeenCalledOnce();
        expect(renderOfferLetterHtml).toHaveBeenCalledOnce();
        expect(out.filename).toBe('Offer_Letter_John_Doe.pdf');
        expect(putBlob).not.toHaveBeenCalled();
        expect(Letter.create).not.toHaveBeenCalled();
        expect(recordAudit).not.toHaveBeenCalled();
    });
});

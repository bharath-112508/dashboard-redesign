import { Types } from 'mongoose';
import crypto from 'node:crypto';

import { Payslip, type PayslipDocument } from '../models/payslip.model.js';
import { buildPayslipRenderData } from './payroll/render-adapter.service.js';
import { renderPayslipHtmlFromData, payslipNetPayFromData } from './payroll/payslip-template.js';
import { htmlToPdf } from './payroll/pdf.service.js';
import { putBlob, mintDownloadSas } from '../utils/azure-blob.js';
import { AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER } from '../config/server.config.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { ListPayslipsQuery } from '../validators/payslip.validator.js';

/**
 * Payslip generation service (Task 7).
 *
 * Single vertical slice: adapt platform models → render-data (Task 6) →
 * render HTML (Task 2 template) → rasterize to PDF (Playwright-backed
 * `htmlToPdf`) → upload to a private Azure Blob container → persist an
 * immutable `Payslip` row (with the exact render snapshot + content hash)
 * → audit the generation act → mint a short-lived download SAS for the
 * caller's immediate use.
 *
 * The PDF itself is never re-derived from the row on download — the blob
 * is the source of truth for bytes; `downloadPayslip` just mints a fresh
 * SAS pointing at the same `blob_key`.
 */

export interface PayrollCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

const DOWNLOAD_TTL_MIN = 10;

const toPublic = (d: PayslipDocument): Record<string, unknown> => d.toJSON() as Record<string, unknown>;

const safeFileNameOf = (name: string | undefined): string => (name ?? 'Payslip').replace(/\s+/g, '_');

// ─── POST /payslips ──────────────────────────────────────────────────────

export const generatePayslip = async (
    input: { user_id: Types.ObjectId; pay_period: string; days_present: number; effective_on: string },
    caller: PayrollCaller
): Promise<Record<string, unknown>> => {
    const data = await buildPayslipRenderData(input.user_id, input.pay_period, input.days_present, input.effective_on);
    const html = renderPayslipHtmlFromData(data);
    const pdf = await htmlToPdf(html);
    const netPay = payslipNetPayFromData(data);
    const contentHash = crypto.createHash('sha256').update(pdf).digest('hex');
    const safeName = safeFileNameOf(data.employeeName);
    const blobKey = `payslips/${input.user_id.toString()}/${input.pay_period}/${contentHash.slice(0, 12)}.pdf`;

    await putBlob({
        container: AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER,
        blobKey,
        body: pdf,
        contentType: 'application/pdf',
    });

    const rec = await Payslip.create({
        user_id: input.user_id,
        pay_period: input.pay_period,
        days_present: input.days_present,
        net_pay: netPay,
        render_snapshot: data,
        blob_key: blobKey,
        content_hash: contentHash,
        generated_by: caller.id,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PAYSLIP_GENERATE,
            target: { kind: AUDIT_TARGET_KINDS.PAYSLIP, id: rec._id },
            after: { user_id: input.user_id.toString(), pay_period: input.pay_period, net_pay: netPay },
        });
    }

    const sas = mintDownloadSas({
        container: AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER,
        blobKey,
        ttlMinutes: DOWNLOAD_TTL_MIN,
        fileName: `Payslip_${safeName}_${input.pay_period}.pdf`,
    });

    return { ...toPublic(rec), download_url: sas.url };
};

// ─── POST /payslips/preview ──────────────────────────────────────────────

/**
 * Renders the exact same payslip PDF as `generatePayslip`, but stops before
 * `putBlob`/`Payslip.create`/`recordAudit` — no blob, no DB row, no audit
 * trail. Lets an admin eyeball the render before committing to generation.
 */
export const previewPayslip = async (input: {
    user_id: Types.ObjectId;
    pay_period: string;
    days_present: number;
    effective_on: string;
}): Promise<{ pdf_base64: string; filename: string; net_pay: number }> => {
    const data = await buildPayslipRenderData(input.user_id, input.pay_period, input.days_present, input.effective_on);
    const html = renderPayslipHtmlFromData(data);
    const pdf = await htmlToPdf(html);
    const netPay = payslipNetPayFromData(data);
    const safeName = safeFileNameOf(data.employeeName);

    return {
        pdf_base64: pdf.toString('base64'),
        filename: `Payslip_${safeName}_${input.pay_period}.pdf`,
        net_pay: netPay,
    };
};

// ─── GET /payslips ───────────────────────────────────────────────────────

export const listPayslips = async (
    query: ListPayslipsQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};
    if (query.user_id) filter.user_id = new Types.ObjectId(query.user_id);
    if (query.pay_period) filter.pay_period = query.pay_period;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        Payslip.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        Payslip.countDocuments(filter),
    ]);

    return {
        data: rows.map(toPublic),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── GET /payslips/:id/download ──────────────────────────────────────────

export const downloadPayslip = async (id: Types.ObjectId): Promise<{ download_url: string }> => {
    const rec = await Payslip.findById(id);
    if (!rec) throw AppError.notFound('Payslip not found', ERROR_CODES.PAYSLIP_NOT_FOUND);

    const snapshot = rec.render_snapshot as { employeeName?: string } | null | undefined;
    const safeName = safeFileNameOf(snapshot?.employeeName);

    const sas = mintDownloadSas({
        container: AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER,
        blobKey: rec.blob_key,
        ttlMinutes: DOWNLOAD_TTL_MIN,
        fileName: `Payslip_${safeName}_${rec.pay_period}.pdf`,
    });

    return { download_url: sas.url };
};

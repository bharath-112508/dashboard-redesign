import { Types } from 'mongoose';
import crypto from 'node:crypto';

import { Letter, type LetterDocument, type LetterType } from '../models/letter.model.js';
import {
    buildLetterRenderData,
    getCompanyBlock,
    type LetterRenderDataOverrides,
} from './payroll/render-adapter.service.js';
import { renderLetterHtml, type InternshipDetails } from './payroll/letter-template.js';
import {
    renderOfferLetterHtml,
    type OfferCtcRow,
    type OfferLetterRenderData,
} from './payroll/offer-letter-template.js';
import { htmlToPdf } from './payroll/pdf.service.js';
import { putBlob, mintDownloadSas } from '../utils/azure-blob.js';
import { AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER } from '../config/server.config.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { GenerateLetterBody, ListLettersQuery } from '../validators/letter.validator.js';

/**
 * Letter generation service (Task 8) — offer, relieving, experience,
 * internship, hike, and promotion letters. Structurally identical to
 * `payslip.service.ts` (Task 7): adapt platform models → render-data →
 * render HTML → rasterize to PDF → upload to the private payroll Azure Blob
 * container → persist an immutable `Letter` row → audit → mint a
 * short-lived download SAS.
 *
 * ── OFFER LETTER DATA-SOURCE DECISION ──────────────────────────────────
 * `buildLetterRenderData` (Task 6) always returns a `LetterRenderData` —
 * the shape consumed by `renderLetterHtml` for the 5 *employee* letter
 * types (relieving/experience/internship/hike/promotion). It does NOT
 * produce an `OfferLetterRenderData` (candidateName/candidateAddress/
 * ctcBreakdown/probationMonths/etc. — a materially different shape,
 * consumed by `renderOfferLetterHtml`), and it never will by design: an
 * offer is extended to a CANDIDATE, who is typically not yet a `User` row
 * in the platform (no `internal_profile`, no `SalaryStructure`). Deriving
 * offer data from `buildLetterRenderData`/employee lookups would either
 * 404 on `USER_NOT_FOUND` for genuine external candidates, or silently
 * misuse an existing employee's record for what is supposed to be a new
 * hire's offer.
 *
 * So for `type === 'offer'`, this service does NOT call
 * `buildLetterRenderData`. It builds the `OfferLetterRenderData` from
 * `getCompanyBlock()` (company/signatory fields — genuinely shared across
 * every document type) plus the request body's offer-specific fields
 * (candidate name/address/email, role, compensation breakdown, terms).
 * `user_id` is still required and stored on the `Letter` row (so an offer
 * can be linked to the `User` record created once the candidate joins),
 * but it is NOT used to look up salary/profile data for the offer PDF
 * itself. This is a deliberate scope decision, flagged here and in the
 * task report for reviewer sign-off.
 */

export interface PayrollCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

const DOWNLOAD_TTL_MIN = 10;

const toPublic = (d: LetterDocument): Record<string, unknown> => d.toJSON() as Record<string, unknown>;

const safeFileNameOf = (name: string | undefined): string => (name ?? 'Letter').replace(/\s+/g, '_');

/** Reuses the source app's `letterKind` filename mapping (Task 8 brief). */
const LETTER_KIND: Record<LetterType, string> = {
    offer: 'Offer_Letter',
    relieving: 'Relieving_Letter',
    experience: 'Experience_Letter',
    internship: 'Internship_Experience_Letter',
    hike: 'Salary_Revision_Letter',
    promotion: 'Promotion_Letter',
};

const filenameFor = (type: LetterType, name: string | undefined): string =>
    `${LETTER_KIND[type]}_${safeFileNameOf(name)}.pdf`;

/** Builds the `LetterRenderDataOverrides` from the validated request body —
 * only the fields relevant to `buildLetterRenderData`'s 5 employee letter
 * types (not the offer-only fields). */
const buildEmployeeOverrides = (input: GenerateLetterBody): LetterRenderDataOverrides => {
    const overrides: LetterRenderDataOverrides = {};
    if (input.issue_date !== undefined) overrides.issueDate = input.issue_date;
    if (input.reference !== undefined) overrides.reference = input.reference;
    if (input.last_working_day !== undefined) overrides.lastWorkingDay = input.last_working_day;
    if (input.internship !== undefined) overrides.internship = input.internship as InternshipDetails;
    if (input.effective_date !== undefined) overrides.effectiveDate = input.effective_date;
    if (input.previous_ctc !== undefined) overrides.previousCtc = input.previous_ctc;
    if (input.new_ctc !== undefined) overrides.newCtc = input.new_ctc;
    if (input.previous_designation !== undefined) overrides.previousDesignation = input.previous_designation;
    if (input.new_designation !== undefined) overrides.newDesignation = input.new_designation;
    if (input.previous_department !== undefined) overrides.previousDepartment = input.previous_department;
    if (input.new_department !== undefined) overrides.newDepartment = input.new_department;
    if (input.location !== undefined) overrides.location = input.location;
    if (input.salutation !== undefined) overrides.salutation = input.salutation;
    if (input.body_paragraphs !== undefined) overrides.bodyParagraphs = input.body_paragraphs;
    if (input.closing !== undefined) overrides.closing = input.closing;
    if (input.signatory_name !== undefined) overrides.signatoryName = input.signatory_name;
    if (input.signatory_title !== undefined) overrides.signatoryTitle = input.signatory_title;
    return overrides;
};

/** Builds the `OfferLetterRenderData` from the company block + the request
 * body's offer fields (see the module-level doc comment for why offer data
 * doesn't flow through `buildLetterRenderData`). */
const buildOfferRenderData = async (input: GenerateLetterBody): Promise<OfferLetterRenderData> => {
    const company = await getCompanyBlock();

    return {
        companyName: company.companyName,
        companyAddress: company.companyAddress,
        companyEmail: company.companyEmail,
        cinNo: company.cinNo,
        iecCode: company.iecCode,

        issueDate: input.issue_date ?? '',
        reference: input.reference,
        offerValidUntil: input.offer_valid_until,

        candidateName: input.candidate_name ?? '',
        candidateAddress: input.candidate_address ?? [],
        candidateEmail: input.candidate_email ?? '',
        candidatePhone: input.candidate_phone,

        designation: input.designation ?? '',
        department: input.department ?? '',
        location: input.location ?? '',
        reportingManager: input.reporting_manager ?? '',
        joiningDate: input.joining_date ?? '',
        employmentType: input.employment_type ?? '',

        probationMonths: input.probation_months ?? 0,
        noticePeriodDays: input.notice_period_days ?? 0,
        workingHours: input.working_hours ?? '',
        workingDays: input.working_days ?? '',

        ctcBreakdown: (input.ctc_breakdown ?? []) as OfferCtcRow[],

        bodyParagraphs: input.body_paragraphs,
        termsParagraphs: input.terms_paragraphs,
        closing: input.closing,
        signatoryName: input.signatory_name,
        signatoryTitle: input.signatory_title,
    };
};

// ─── POST /letters ────────────────────────────────────────────────────────

export const generateLetter = async (
    input: GenerateLetterBody,
    caller: PayrollCaller
): Promise<Record<string, unknown>> => {
    const userId = new Types.ObjectId(input.user_id);

    let html: string;
    let data: unknown;
    let subjectName: string | undefined;

    if (input.type === 'offer') {
        data = await buildOfferRenderData(input);
        html = renderOfferLetterHtml(data as OfferLetterRenderData);
        subjectName = (data as OfferLetterRenderData).candidateName;
    } else {
        data = await buildLetterRenderData(userId, input.type, buildEmployeeOverrides(input));
        html = renderLetterHtml(data as Parameters<typeof renderLetterHtml>[0]);
        subjectName = (data as { employeeName?: string }).employeeName;
    }

    const pdf = await htmlToPdf(html);
    const contentHash = crypto.createHash('sha256').update(pdf).digest('hex');
    const blobKey = `letters/${userId.toString()}/${input.type}/${contentHash.slice(0, 12)}.pdf`;

    await putBlob({
        container: AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER,
        blobKey,
        body: pdf,
        contentType: 'application/pdf',
    });

    const rec = await Letter.create({
        user_id: userId,
        type: input.type,
        reference: input.reference,
        render_snapshot: data,
        blob_key: blobKey,
        content_hash: contentHash,
        generated_by: caller.id,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.LETTER_GENERATE,
            target: { kind: AUDIT_TARGET_KINDS.LETTER, id: rec._id },
            after: { user_id: userId.toString(), type: input.type },
        });
    }

    const sas = mintDownloadSas({
        container: AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER,
        blobKey,
        ttlMinutes: DOWNLOAD_TTL_MIN,
        fileName: filenameFor(input.type, subjectName),
    });

    return { ...toPublic(rec), download_url: sas.url };
};

// ─── GET /letters ─────────────────────────────────────────────────────────

export const listLetters = async (
    query: ListLettersQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};
    if (query.user_id) filter.user_id = new Types.ObjectId(query.user_id);
    if (query.type) filter.type = query.type;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        Letter.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        Letter.countDocuments(filter),
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

// ─── GET /letters/:id/download ───────────────────────────────────────────

export const downloadLetter = async (id: Types.ObjectId): Promise<{ download_url: string }> => {
    const rec = await Letter.findById(id);
    if (!rec) throw AppError.notFound('Letter not found', ERROR_CODES.LETTER_NOT_FOUND);

    const snapshot = rec.render_snapshot as { employeeName?: string; candidateName?: string } | null | undefined;
    const safeName = snapshot?.employeeName ?? snapshot?.candidateName;

    const sas = mintDownloadSas({
        container: AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER,
        blobKey: rec.blob_key,
        ttlMinutes: DOWNLOAD_TTL_MIN,
        fileName: filenameFor(rec.type, safeName),
    });

    return { download_url: sas.url };
};

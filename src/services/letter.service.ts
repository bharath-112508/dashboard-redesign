import { Types } from 'mongoose';
import crypto from 'node:crypto';

import { Letter, type LetterDocument, type LetterType } from '../models/letter.model.js';
import {
    buildJoiningRenderData,
    buildLetterRenderData,
    buildManualJoiningRenderData,
    formatRenderDate,
    getCompanyBlock,
    type JoiningRenderDataOverrides,
    type LetterRenderDataOverrides,
} from './payroll/render-adapter.service.js';
import { renderLetterHtml, type InternshipDetails } from './payroll/letter-template.js';
import {
    renderOfferLetterHtml,
    type OfferCtcRow,
    type OfferLetterRenderData,
} from './payroll/offer-letter-template.js';
import {
    renderInternshipOfferLetterHtml,
    type InternshipOfferRenderData,
} from './payroll/internship-offer-letter-template.js';
import { htmlToPdf } from './payroll/pdf.service.js';
import { putBlob, mintDownloadSas, deleteBlob } from '../utils/azure-blob.js';
import { AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER } from '../config/server.config.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import { User } from '../models/user.model.js';
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
    joining: 'Appointment_Letter',
    internship_offer: 'Internship_Offer_Letter',
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

/** Builds the `JoiningRenderDataOverrides` from the validated request body —
 * the appointment terms an admin sets; everything else (name, role, DOJ,
 * compensation) the adapter derives from the employee record + salary
 * structure. Reuses the shared offer-style term fields. */
const buildJoiningOverrides = (input: GenerateLetterBody): JoiningRenderDataOverrides => {
    const overrides: JoiningRenderDataOverrides = {};
    if (input.issue_date !== undefined) overrides.issueDate = input.issue_date;
    if (input.reference !== undefined) overrides.reference = input.reference;
    if (input.candidate_name !== undefined) overrides.candidateName = input.candidate_name;
    if (input.candidate_email !== undefined) overrides.candidateEmail = input.candidate_email;
    if (input.designation !== undefined) overrides.designation = input.designation;
    if (input.department !== undefined) overrides.department = input.department;
    if (input.joining_date !== undefined) overrides.joiningDate = input.joining_date;
    if (input.location !== undefined) overrides.location = input.location;
    if (input.reporting_manager !== undefined) overrides.reportingManager = input.reporting_manager;
    if (input.employment_type !== undefined) overrides.employmentType = input.employment_type;
    if (input.probation_months !== undefined) overrides.probationMonths = input.probation_months;
    if (input.notice_period_days !== undefined) overrides.noticePeriodDays = input.notice_period_days;
    if (input.working_hours !== undefined) overrides.workingHours = input.working_hours;
    if (input.working_days !== undefined) overrides.workingDays = input.working_days;
    if (input.ctc_breakdown !== undefined) overrides.ctcBreakdown = input.ctc_breakdown as OfferCtcRow[];
    if (input.additional_terms !== undefined) overrides.additionalTerms = input.additional_terms;
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

        issueDate: formatRenderDate(input.issue_date),
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
        joiningDate: formatRenderDate(input.joining_date),
        employmentType: input.employment_type ?? '',

        probationMonths: input.probation_months ?? 0,
        noticePeriodDays: input.notice_period_days ?? 0,
        workingHours: input.working_hours ?? '',
        workingDays: input.working_days ?? '',

        ctcBreakdown: (input.ctc_breakdown ?? []) as OfferCtcRow[],

        bodyParagraphs: input.body_paragraphs,
        termsParagraphs: input.terms_paragraphs,
        additionalTerms: input.additional_terms,
        closing: input.closing,
        signatoryName: input.signatory_name,
        signatoryTitle: input.signatory_title,
    };
};

/**
 * Build the internship-offer render data.
 *
 * Sourced from the request body like `offer`, for the same reason: the
 * subject is usually a candidate with no `User` row, no salary structure and
 * no employment profile to read from. `user_id` is optional — when present
 * it's stored on the `Letter` row so the document is findable under that
 * person, and their name/email seed the letter, but nothing else is
 * auto-derived.
 */
const buildInternshipOfferRenderData = async (
    input: GenerateLetterBody,
    userId?: Types.ObjectId
): Promise<InternshipOfferRenderData> => {
    const company = await getCompanyBlock();

    // When an existing user was picked, their name/email seed the letter but
    // an explicitly typed name still wins — the operator is looking at the
    // form and we shouldn't silently overwrite what they entered.
    let seededName = '';
    let seededEmail = '';
    if (userId) {
        const u = await User.findById(userId).select('full_name email').lean<{
            full_name?: string;
            email?: string;
        } | null>();
        seededName = u?.full_name ?? '';
        seededEmail = u?.email ?? '';
    }

    return {
        companyName: company.companyName,
        companyAddress: company.companyAddress,
        companyEmail: company.companyEmail,
        cinNo: company.cinNo,
        iecCode: company.iecCode,

        issueDate: formatRenderDate(input.issue_date),
        reference: input.reference,
        offerValidUntil: input.offer_valid_until ? formatRenderDate(input.offer_valid_until) : undefined,

        internName: input.candidate_name?.trim() || seededName,
        internAddress: input.candidate_address ?? [],
        internEmail: input.candidate_email?.trim() || seededEmail,
        internPhone: input.candidate_phone,

        position: input.position ?? '',
        startDate: formatRenderDate(input.internship_start_date),
        endDate: formatRenderDate(input.internship_end_date),
        durationLabel: input.internship_duration ?? '',
        workMode: input.work_mode ?? '',

        isPaid: input.is_paid === true,
        stipendAmount: input.stipend_amount,
        stipendNote: input.stipend_note,

        bodyParagraphs: input.body_paragraphs,
        responsibilities: input.responsibilities ?? [],
        terms: input.general_terms ?? [],
        closing: input.closing,
        signatoryName: input.signatory_name,
        signatoryTitle: input.signatory_title,
    };
};

/**
 * Pick the template + build its data for a request.
 *
 * One function because `generateLetter`, `previewLetter` and
 * `previewLetterHtml` all need exactly this and previously each carried
 * their own copy of the if/else. Three copies meant a new letter type could
 * be wired into two of them and silently render the WRONG template in the
 * live preview — a failure you'd only notice by eyeballing the page.
 */
const resolveRender = async (
    input: GenerateLetterBody
): Promise<{ html: string; data: unknown; subjectName?: string }> => {
    const userId = input.user_id ? new Types.ObjectId(input.user_id) : undefined;

    if (input.type === 'offer') {
        const data = await buildOfferRenderData(input);
        return { html: renderOfferLetterHtml(data), data, subjectName: data.candidateName };
    }
    if (input.type === 'joining') {
        const data = userId
            ? await buildJoiningRenderData(userId, buildJoiningOverrides(input))
            : await buildManualJoiningRenderData(buildJoiningOverrides(input));
        return { html: renderOfferLetterHtml(data), data, subjectName: data.candidateName };
    }
    if (input.type === 'internship_offer') {
        const data = await buildInternshipOfferRenderData(input, userId);
        return {
            html: renderInternshipOfferLetterHtml(data),
            data,
            subjectName: data.internName,
        };
    }
    // Validated: every remaining type requires user_id.
    const data = await buildLetterRenderData(userId!, input.type, buildEmployeeOverrides(input));
    return {
        html: renderLetterHtml(data as Parameters<typeof renderLetterHtml>[0]),
        data,
        subjectName: (data as { employeeName?: string }).employeeName,
    };
};

// ─── POST /letters ────────────────────────────────────────────────────────

export const generateLetter = async (
    input: GenerateLetterBody,
    caller: PayrollCaller
): Promise<Record<string, unknown>> => {
    // `user_id` is optional for the types that may name a person manually.
    const userId = input.user_id ? new Types.ObjectId(input.user_id) : undefined;

    const { html, data, subjectName } = await resolveRender(input);

    const pdf = await htmlToPdf(html);
    const contentHash = crypto.createHash('sha256').update(pdf).digest('hex');
    const blobKey = `letters/${userId?.toString() ?? 'unlinked'}/${input.type}/${contentHash.slice(0, 12)}.pdf`;

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
            after: { user_id: userId?.toString(), type: input.type },
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

// ─── POST /letters/preview ────────────────────────────────────────────────

/**
 * Renders the exact same letter PDF as `generateLetter`, but stops before
 * `putBlob`/`Letter.create`/`recordAudit` — no blob, no DB row, no audit
 * trail. Lets an admin eyeball the render before committing to generation.
 */
export const previewLetter = async (input: GenerateLetterBody): Promise<{ pdf_base64: string; filename: string }> => {
    const { html, subjectName } = await resolveRender(input);

    const pdf = await htmlToPdf(html);

    return {
        pdf_base64: pdf.toString('base64'),
        filename: filenameFor(input.type, subjectName),
    };
};

/**
 * Renders the letter template to raw HTML — no Playwright, no blob, no record.
 * Powers the on-page live preview (instant; shows the clean document). Same
 * template the PDF is rendered from.
 */
export const previewLetterHtml = async (input: GenerateLetterBody): Promise<{ html: string; filename: string }> => {
    const { html, subjectName } = await resolveRender(input);

    return { html, filename: filenameFor(input.type, subjectName) };
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

// ─── DELETE /letters/:id ─────────────────────────────────────────────────

/**
 * Permanently removes an issued letter: deletes the PDF blob (best-effort —
 * `deleteBlob` never throws, so a briefly-unreachable Azure doesn't block the
 * row removal) then the `Letter` row, and audits the deletion.
 */
export const deleteLetter = async (id: Types.ObjectId, caller: PayrollCaller): Promise<void> => {
    const rec = await Letter.findById(id);
    if (!rec) throw AppError.notFound('Letter not found', ERROR_CODES.LETTER_NOT_FOUND);

    await deleteBlob(AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER, rec.blob_key);
    await rec.deleteOne();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.LETTER_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.LETTER, id: rec._id },
            before: { user_id: rec.user_id?.toString(), type: rec.type },
        });
    }
};

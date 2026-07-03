import { z } from 'zod';

import { LETTER_TYPES } from '../models/letter.model.js';

/**
 * Zod schemas for `/letters/*` (Task 8).
 *
 * `generateLetterBodySchema` is a single `.strict()` object (not a
 * discriminated union) covering the base fields common to every letter type
 * plus every type-specific optional field across all 6 types — mirroring
 * `LetterRenderDataOverrides` (5 employee letter types, driven by
 * `buildLetterRenderData`) and `OfferLetterRenderData` (the `offer` type,
 * built from these body fields directly — see `letter.service.ts`). Using
 * one flat `.strict()` object (rather than a `z.discriminatedUnion`) keeps
 * this consistent with the rest of the payroll validators and avoids
 * duplicating the base fields per branch; the service is responsible for
 * only reading the fields relevant to the given `type`.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

const internshipDetailsSchema = z
    .object({
        startDate: z.string().min(1),
        endDate: z.string().min(1),
        designation: z.string().min(1),
    })
    .strict();

const offerCtcRowSchema = z
    .object({
        label: z.string().trim().min(1).max(80),
        amount: z.number().min(0),
        note: z.string().max(200).optional(),
    })
    .strict();

// ─── POST /letters ───────────────────────────────────────────────────────

export const generateLetterBodySchema = z
    .object({
        // Base — every letter type. `user_id` is required for all types
        // EXCEPT `joining`, which may be issued for a person not yet added as
        // a User (name captured manually) — enforced in the superRefine below.
        type: z.enum(LETTER_TYPES),
        user_id: objectIdSchema.optional(),
        issue_date: z.string().min(1).optional(),
        reference: z.string().min(1).max(120).optional(),

        // relieving / experience / internship / hike / promotion —
        // matches LetterRenderDataOverrides (buildLetterRenderData).
        last_working_day: isoDateSchema.optional(),
        internship: internshipDetailsSchema.optional(),
        effective_date: isoDateSchema.optional(),
        previous_ctc: z.number().min(0).optional(),
        new_ctc: z.number().min(0).optional(),
        previous_designation: z.string().min(1).max(120).optional(),
        new_designation: z.string().min(1).max(120).optional(),
        previous_department: z.string().min(1).max(120).optional(),
        new_department: z.string().min(1).max(120).optional(),
        location: z.string().min(1).max(120).optional(),
        salutation: z.string().min(1).max(120).optional(),
        body_paragraphs: z.array(z.string().min(1)).optional(),
        closing: z.string().min(1).max(200).optional(),
        signatory_name: z.string().min(1).max(120).optional(),
        signatory_title: z.string().min(1).max(120).optional(),

        // offer — matches OfferLetterRenderData; sourced entirely from the
        // request body (candidates aren't platform Users).
        offer_valid_until: z.string().min(1).optional(),
        candidate_name: z.string().min(1).max(160).optional(),
        candidate_address: z.array(z.string().min(1)).optional(),
        candidate_email: z.string().email().optional(),
        candidate_phone: z.string().min(1).max(40).optional(),
        designation: z.string().min(1).max(120).optional(),
        department: z.string().min(1).max(120).optional(),
        reporting_manager: z.string().min(1).max(160).optional(),
        joining_date: z.string().min(1).optional(),
        employment_type: z.string().min(1).max(80).optional(),
        probation_months: z.number().int().min(0).optional(),
        notice_period_days: z.number().int().min(0).optional(),
        working_hours: z.string().min(1).max(120).optional(),
        working_days: z.string().min(1).max(120).optional(),
        ctc_breakdown: z.array(offerCtcRowSchema).optional(),
        terms_paragraphs: z.array(z.string().min(1)).optional(),
        // offer / joining — extra per-employee clauses appended to Terms & Conditions.
        additional_terms: z.array(z.string().min(1).max(500)).max(20).optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
        // `user_id` is required for every type except `joining`. A joining
        // (appointment) letter can be issued either for an existing employee
        // (user_id → auto-sourced record/salary) OR manually for a not-yet-
        // added person (candidate_name), but it needs at least one of the two.
        if (val.type !== 'joining') {
            if (!val.user_id) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['user_id'],
                    message: 'user_id is required',
                });
            }
        } else if (!val.user_id && (!val.candidate_name || val.candidate_name.trim() === '')) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['candidate_name'],
                message: 'Select an employee or enter a name for the joining letter',
            });
        }

        // Every type-specific field above is optional at the flat-schema
        // level (see the module doc comment). Without this refine, e.g.
        // `{ type: 'offer', user_id }` passes validation and silently
        // generates a blank "Dear Candidate ... the role offered" PDF with
        // an empty CTC table (see letter.service.ts buildOfferRenderData —
        // every offer field falls back to `''`/`[]` when absent). Require
        // the fields each type actually needs for a meaningful letter.
        if (val.type === 'offer') {
            if (!val.candidate_name || val.candidate_name.trim() === '') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['candidate_name'],
                    message: 'candidate_name is required for an offer letter',
                });
            }
            if (!val.designation || val.designation.trim() === '') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['designation'],
                    message: 'designation is required for an offer letter',
                });
            }
            if (!val.ctc_breakdown || val.ctc_breakdown.length === 0) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['ctc_breakdown'],
                    message: 'ctc_breakdown must have at least one row for an offer letter',
                });
            }
        }

        if (val.type === 'hike' || val.type === 'promotion') {
            if (!val.effective_date) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['effective_date'],
                    message: `effective_date is required for a ${val.type} letter`,
                });
            }
            if (!val.new_designation || val.new_designation.trim() === '') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['new_designation'],
                    message: `new_designation is required for a ${val.type} letter`,
                });
            }
        }

        if (val.type === 'relieving' || val.type === 'experience') {
            if (!val.last_working_day) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['last_working_day'],
                    message: `last_working_day is required for a ${val.type} letter`,
                });
            }
        }

        // `internship` (Task 8): every field the template renders
        // (employeeName/designation/dateOfJoining) is derived from the
        // platform User/PayrollProfile in `buildLetterRenderData`, not from
        // the request body — an internship letter still renders a
        // meaningful document with zero body overrides. The nested
        // `internship {startDate, endDate, designation}` block is itself
        // optional even in the template (falls back to dateOfJoining /
        // lastWorkingDay — see letter-template.ts `defaultBody`), so there
        // is no single request-body field that's strictly required here.
        // Deliberately left unconstrained.
    });
export type GenerateLetterBody = z.infer<typeof generateLetterBodySchema>;

// ─── GET /letters ────────────────────────────────────────────────────────

export const listLettersQuerySchema = z
    .object({
        user_id: objectIdSchema.optional(),
        type: z.enum(LETTER_TYPES).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .strict();
export type ListLettersQuery = z.infer<typeof listLettersQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const letterIdPathSchema = z.object({ id: objectIdSchema });
export type LetterIdPath = z.infer<typeof letterIdPathSchema>;

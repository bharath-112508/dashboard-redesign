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
        // Base — every letter type.
        type: z.enum(LETTER_TYPES),
        user_id: objectIdSchema,
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
    })
    .strict();
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

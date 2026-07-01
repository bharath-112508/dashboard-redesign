import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `letters` — one immutable row per generated letter PDF (Task 8).
 *
 * Covers all 6 letter types: offer, relieving, experience, internship, hike,
 * promotion. Like `payslips` (Task 7), a letter is never edited in place —
 * re-running generation creates a NEW row with a fresh `blob_key` /
 * `content_hash`. `render_snapshot` freezes the exact render-data payload
 * used to produce the PDF (the `LetterRenderData` shape for the 5 employee
 * letter types, or the ad-hoc offer-letter data for `type: 'offer'` — see
 * `letter.service.ts` for why offer letters don't go through
 * `buildLetterRenderData`).
 *
 * The PDF bytes live in the same **private** Azure Blob container as
 * payslips (`AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER`); `blob_key` is the
 * pointer, `content_hash` (SHA-256 of the PDF bytes) is a tamper-evidence
 * check. Downloads are always short-lived SAS URLs.
 */

export const LETTER_TYPES = ['offer', 'relieving', 'experience', 'internship', 'hike', 'promotion'] as const;
export type LetterType = (typeof LETTER_TYPES)[number];

export interface LetterDocument extends Document {
    _id: Types.ObjectId;

    user_id: Types.ObjectId;
    type: LetterType;
    reference?: string;
    render_snapshot: unknown;
    blob_key: string;
    content_hash: string;
    generated_by: Types.ObjectId;

    created_at: Date;
    updated_at: Date;
}

const letterSchema = new Schema<LetterDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        type: { type: String, enum: LETTER_TYPES, required: true },
        reference: { type: String, trim: true },
        render_snapshot: { type: Schema.Types.Mixed, required: true },
        blob_key: { type: String, required: true },
        content_hash: { type: String, required: true },
        generated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.LETTERS }
);

letterSchema.index({ user_id: 1, type: 1, created_at: -1 });

export const Letter: Model<LetterDocument> = model<LetterDocument>('Letter', letterSchema);

import { Types } from 'mongoose';

import { Holiday, type HolidayDocument } from '../models/holiday.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import type {
    BulkCreateHolidaysBody,
    CreateHolidayBody,
    ListHolidaysQuery,
    PatchHolidayBody,
} from '../validators/holiday.validator.js';

/**
 * Holiday calendar service (API_Contract.md §4.3, Data_Model.md §2.3).
 *
 *  - `date` is uniquely indexed at the DB layer; we surface E11000 as a
 *    canonical 409 `DUPLICATE_RESOURCE` so the FE can show "this date is
 *    already on the calendar" without parsing Mongo errors.
 *  - List supports `(from_date, to_date)` and a convenience `year` shorthand.
 *    `year` expands to `from_date=YYYY-01-01`, `to_date=YYYY-12-31` only when
 *    no explicit range was passed; explicit range always wins.
 *  - Bulk insert is best-effort atomic: we rely on Mongo's `insertMany` with
 *    `ordered: false` so a partial duplicate doesn't tank the whole import.
 *    We then surface a structured response — `{ inserted, skipped }` — so the
 *    UI can tell the admin which dates collided. Validator-layer dedup
 *    already guarantees no in-payload dupes.
 */

type Filter = Record<string, unknown>;

const toPublic = (doc: HolidayDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;
const toPublicMany = (docs: HolidayDocument[]): Record<string, unknown>[] => docs.map(toPublic);

const isE11000 = (err: unknown): err is { code: 11000; keyValue?: { date?: string } } =>
    !!err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000;

// ─── POST /holidays ────────────────────────────────────────────────────────

export const createHoliday = async (
    input: CreateHolidayBody,
    created_by: Types.ObjectId
): Promise<Record<string, unknown>> => {
    try {
        const doc = await Holiday.create({
            date: input.date,
            name: input.name,
            is_optional: input.is_optional ?? false,
            created_by,
        });
        return toPublic(doc);
    } catch (err: unknown) {
        if (isE11000(err)) {
            throw AppError.conflict(`A holiday already exists for ${input.date}`, ERROR_CODES.DUPLICATE_RESOURCE, {
                date: input.date,
            });
        }
        throw err;
    }
};

// ─── POST /holidays/bulk ──────────────────────────────────────────────────

export const bulkCreateHolidays = async (
    input: BulkCreateHolidaysBody,
    created_by: Types.ObjectId
): Promise<{ inserted: Record<string, unknown>[]; skipped: { date: string; reason: string }[] }> => {
    // Precheck: any of these dates already on the calendar? Stripping them up
    // front lets us return the cleanest possible "skipped" report.
    const requestedDates = input.items.map((i) => i.date);
    const existing = await Holiday.find({ date: { $in: requestedDates } }).select({ date: 1, _id: 0 });
    const existingDates = new Set(existing.map((d) => d.date));

    const toInsert = input.items
        .filter((i) => !existingDates.has(i.date))
        .map((i) => ({
            date: i.date,
            name: i.name,
            is_optional: i.is_optional ?? false,
            created_by,
        }));

    const skipped: { date: string; reason: string }[] = Array.from(existingDates).map((d) => ({
        date: d,
        reason: 'already_exists',
    }));

    if (toInsert.length === 0) {
        return { inserted: [], skipped };
    }

    // `ordered: false` so a race-condition collision (a single date inserted
    // between the precheck and this call) doesn't abort the whole batch.
    let inserted: HolidayDocument[] = [];
    try {
        inserted = (await Holiday.insertMany(toInsert, { ordered: false })) as HolidayDocument[];
    } catch (err: unknown) {
        // BulkWriteError still returns `insertedDocs` for the rows that
        // succeeded; harvest those and tag the rest as racing duplicates.
        const bulkErr = err as {
            insertedDocs?: HolidayDocument[];
            writeErrors?: { err?: { op?: { date?: string } } }[];
        };
        if (bulkErr.insertedDocs) {
            inserted = bulkErr.insertedDocs;
        }
        if (bulkErr.writeErrors) {
            for (const we of bulkErr.writeErrors) {
                const d = we?.err?.op?.date;
                if (d) skipped.push({ date: d, reason: 'race_condition_duplicate' });
            }
        }
        // Anything that wasn't an E11000 from the unique index is a real bug.
        if (!bulkErr.insertedDocs && !bulkErr.writeErrors) throw err;
    }

    return { inserted: toPublicMany(inserted), skipped };
};

// ─── GET /holidays ─────────────────────────────────────────────────────────

export const listHolidays = async (
    query: ListHolidaysQuery
): Promise<{ data: Record<string, unknown>[]; meta: { total: number; from_date?: string; to_date?: string } }> => {
    let from = query.from_date;
    let to = query.to_date;

    // `year` is a convenience filter: only honoured when no explicit window
    // was passed. This way clients can either say "year=2026" OR
    // "from_date=2025-12-15&to_date=2026-01-15", but the latter wins.
    if (!from && !to && query.year !== undefined) {
        from = `${query.year}-01-01`;
        to = `${query.year}-12-31`;
    }

    const filter: Filter = {};
    if (from && to) {
        filter.date = { $gte: from, $lte: to };
    } else if (from) {
        filter.date = { $gte: from };
    } else if (to) {
        filter.date = { $lte: to };
    }
    if (query.is_optional !== undefined) {
        filter.is_optional = query.is_optional;
    }

    const rows = await Holiday.find(filter).sort({ date: 1 });
    return {
        data: toPublicMany(rows),
        meta: { total: rows.length, ...(from && { from_date: from }), ...(to && { to_date: to }) },
    };
};

// ─── PATCH /holidays/:id ──────────────────────────────────────────────────

export const updateHoliday = async (id: Types.ObjectId, patch: PatchHolidayBody): Promise<Record<string, unknown>> => {
    const doc = await Holiday.findById(id);
    if (!doc) {
        throw AppError.notFound('Holiday not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }

    if (patch.date !== undefined) doc.date = patch.date;
    if (patch.name !== undefined) doc.name = patch.name;
    if (patch.is_optional !== undefined) doc.is_optional = patch.is_optional;

    try {
        await doc.save();
    } catch (err: unknown) {
        if (isE11000(err)) {
            throw AppError.conflict(
                `A holiday already exists for ${patch.date ?? doc.date}`,
                ERROR_CODES.DUPLICATE_RESOURCE,
                { date: patch.date ?? doc.date }
            );
        }
        throw err;
    }

    return toPublic(doc);
};

// ─── DELETE /holidays/:id ─────────────────────────────────────────────────

export const deleteHoliday = async (id: Types.ObjectId): Promise<void> => {
    const result = await Holiday.findByIdAndDelete(id);
    if (!result) {
        throw AppError.notFound('Holiday not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
};

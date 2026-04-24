import { z } from 'zod';

/**
 * Zod schemas for `/office-locations` (API_Contract.md §4.2).
 *
 * Field caps (`name` 200, `address` 500) are deliberately generous — we want
 * "Bangalore HQ — 4th Floor, Tower B, Embassy Tech Village" to fit comfortably
 * but still reject pathological pastes that would blow up the QR PNG size.
 *
 * `qr_code_token` is server-generated and never accepted from the client; no
 * validator covers it.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

const NAME_MAX = 200;
const ADDRESS_MAX = 500;

// ─── POST /office-locations ────────────────────────────────────────────────

export const createOfficeLocationBodySchema = z.object({
    name: z.string().trim().min(1).max(NAME_MAX),
    address: z.string().trim().min(1).max(ADDRESS_MAX),
});

export type CreateOfficeLocationBody = z.infer<typeof createOfficeLocationBodySchema>;

// ─── PATCH /office-locations/:id ──────────────────────────────────────────

export const patchOfficeLocationBodySchema = z
    .object({
        name: z.string().trim().min(1).max(NAME_MAX),
        address: z.string().trim().min(1).max(ADDRESS_MAX),
        is_active: z.boolean(),
    })
    .partial()
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one field must be supplied',
    });

export type PatchOfficeLocationBody = z.infer<typeof patchOfficeLocationBodySchema>;

// ─── GET /office-locations ────────────────────────────────────────────────

export const listOfficeLocationsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    // Default returns BOTH active and inactive — the admin UI needs to see
    // soft-deleted rows to reactivate them. Filtering is opt-in via this flag.
    is_active: z
        .union([z.literal('true'), z.literal('false'), z.boolean()])
        .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
        .optional(),
    q: z.string().trim().min(1).max(100).optional(),
});

export type ListOfficeLocationsQuery = z.infer<typeof listOfficeLocationsQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const officeLocationIdParamSchema = z.object({
    id: objectIdSchema,
});

export type OfficeLocationIdParam = z.infer<typeof officeLocationIdParamSchema>;

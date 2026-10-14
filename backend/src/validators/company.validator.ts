import { z } from 'zod';

import { COMPANY_LOGO_MAX, COMPANY_RESPONSIBLE_ROLES, COMPANY_STATUSES } from '../models/company.model.js';

// Local, matching the convention in the other validators (each declares
// its own rather than importing a shared one).
const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

/**
 * Zod schemas for `/companies` — the client organisation.
 *
 * "Client" means the company; the limited person is a "Representative".
 *
 * `POST /companies/:id/representatives` deliberately has **no `role` and no
 * `company_id` field**. Both are derived server-side: the role is hard-coded
 * to `representative`, and the company comes from the URL (itself checked
 * against the caller's own company for a `client`). If either were accepted
 * from the body, a Client holding `representative.write` could mint an admin
 * or plant someone in another company.
 */

const COMPANY_NAME_MAX = 200;

// ─── POST /companies ─────────────────────────────────────────────────────

/** Company profile fields the redesign edits. All optional; empty strings clear them. */
const companyProfileFields = {
    industry: z.string().trim().max(100),
    country: z.string().trim().max(100),
    website: z.string().trim().max(300),
    notes: z.string().max(5000),
    // An embedded raster image or '' — never a link (a remote URL would let anyone track every viewer)
    // and never SVG. The app always uploads a resized PNG.
    logo: z
        .string()
        .max(COMPANY_LOGO_MAX)
        .regex(/^(data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*)?$/, 'The logo must be a PNG, JPEG, WebP or GIF image.'),
    // `responsibles` is not here: people are set one at a time through /companies/:id/responsibles,
    // which checks each is active staff and cannot lose a concurrent change.
};

export const createCompanyBodySchema = z
    .object({
        name: z.string().trim().min(1, 'Company name is required').max(COMPANY_NAME_MAX),
        ...companyProfileFields,
    })
    .partial({ industry: true, country: true, website: true, notes: true, logo: true })
    .strict();

export type CreateCompanyBody = z.infer<typeof createCompanyBodySchema>;

// ─── PATCH /companies/:id ────────────────────────────────────────────────

export const patchCompanyBodySchema = z
    .object({
        name: z.string().trim().min(1).max(COMPANY_NAME_MAX),
        status: z.enum(COMPANY_STATUSES as unknown as [string, ...string[]]),
        ...companyProfileFields,
    })
    .partial()
    .strict()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' });

export type PatchCompanyBody = z.infer<typeof patchCompanyBodySchema>;

// ─── GET /companies ──────────────────────────────────────────────────────

export const listCompaniesQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        status: z.enum(COMPANY_STATUSES as unknown as [string, ...string[]]).optional(),
        // R15 — min 2 chars so `?q=a` can't trigger a full-collection scan.
        q: z.string().trim().min(2, 'q must be at least 2 characters').max(100).optional(),
    })
    .strict();

export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;

/** `GET /companies/:id/representatives` — a company's people, paginated.
 *  Default 20 matches the companies list; the UI asks for 5. */
export const listRepresentativesQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        /** Matches name or email. Min 2 like every other `q` in the API —
         *  a 1-char search is a full scan with a rank ordering nobody wants. */
        q: z.string().trim().min(2, 'q must be at least 2 characters').max(100).optional(),
    })
    .strict();

export type ListRepresentativesQuery = z.infer<typeof listRepresentativesQuerySchema>;

// ─── POST /companies/:id/representatives ─────────────────────────────────

export const createRepresentativeBodySchema = z
    .object({
        email: z.string().trim().toLowerCase().email(),
        full_name: z.string().trim().min(1).max(200),
        phone: z.string().trim().max(32).optional(),
        timezone: z.string().trim().optional(),
        initial_password: z.string().min(1),
        /** The contact's job title at the client, e.g. "CTO". */
        title: z.string().trim().max(100).optional(),
        /** Email the new contact a link to choose their own password (redesign). */
        send_invite: z.boolean().optional(),
    })
    // `.strict()` is load-bearing here, not stylistic: it rejects a body
    // carrying `role` or `company_id` outright rather than silently ignoring
    // it, so an escalation attempt surfaces as a 400 instead of passing
    // quietly.
    .strict();

export type CreateRepresentativeBody = z.infer<typeof createRepresentativeBodySchema>;

// ─── Params ──────────────────────────────────────────────────────────────

export const companyIdParamSchema = z.object({ id: objectIdSchema });
export type CompanyIdParam = z.infer<typeof companyIdParamSchema>;

export const companyRepresentativeParamSchema = z.object({
    id: objectIdSchema,
    user_id: objectIdSchema,
});
export type CompanyRepresentativeParam = z.infer<typeof companyRepresentativeParamSchema>;

// ─── POST /companies/:id/responsibles (redesign) ─────────────────────────

/** Puts one Viljetech staff member on the company with a role, or changes their role. */
export const setResponsibleBodySchema = z
    .object({ user_id: objectIdSchema, role: z.enum(COMPANY_RESPONSIBLE_ROLES) })
    .strict();

export type SetResponsibleBody = z.infer<typeof setResponsibleBodySchema>;

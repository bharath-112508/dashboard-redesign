import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';

// ─── Phone — BUG-044 ─────────────────────────────────────────────────────
//
// Country-aware validation via libphonenumber-js. Phones must be in E.164
// shape ('+' + country code + national number) so the parser can pick the
// country deterministically. Empty / whitespace input is treated as "not
// supplied" (the BE phone field is optional). When supplied, the value
// must parse AND `.isValid()` — that catches "too few digits for the
// country", impossible country codes, etc.
//
// The transform normalises the value to canonical E.164 (`+15555550123`),
// so downstream callers don't have to deal with whitespace/dashes/parens.
const phoneSchema = z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine(
        (v) => {
            if (v === undefined) return true;
            const parsed = parsePhoneNumberFromString(v);
            return parsed?.isValid() ?? false;
        },
        {
            message:
                "Enter a valid phone in international format ('+' followed by country code and digits) — length and digit count must match the country.",
        }
    )
    .transform((v) => {
        if (v === undefined) return undefined;
        const parsed = parsePhoneNumberFromString(v);
        return parsed?.number ?? v;
    });

// ─── Timezone — BUG-045 ────────────────────────────────────────────────────
//
// Profile used to accept any string here ('IST', ' ', 'India', etc.).
// We require an IANA-style identifier (`Region/City`, or the bare `UTC`)
// and confirm the runtime recognises it via `Intl.DateTimeFormat`.
// Plain `Intl.DateTimeFormat` is otherwise too permissive — it silently
// accepts legacy abbreviations like 'IST'/'EST'/'PST' that we never want
// persisted. The shape gate (`/` or `UTC`) rejects those before the
// resolution step. Empty/whitespace is treated as not supplied.
const isSupportedTimezone = (v: string): boolean => {
    if (v !== 'UTC' && !v.includes('/')) return false;
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: v });
        return true;
    } catch {
        return false;
    }
};

const timezoneSchema = z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || isSupportedTimezone(v), {
        message: 'Pick a supported IANA timezone (e.g. "Asia/Kolkata", "America/New_York").',
    });

/**
 * Zod schemas for `/users` routes.
 *
 * Structural only — password *policy* (10–12 + upper/lower/digit/special) is
 * enforced in the service layer so it surfaces as `422 PASSWORD_POLICY_VIOLATION`
 * per API_Contract §3.2 / §15. Here we just confirm the field exists.
 *
 * Role ↔ profile consistency is enforced via a `.superRefine` on create / patch.
 */

// ─── Shared pieces ─────────────────────────────────────────────────────────

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const dateYMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const emergencyContactSchema = z.object({
    name: z.string().trim().min(1),
    phone: z.string().trim().min(1),
    relation: z.string().trim().min(1),
});

const internalProfileCreateSchema = z.object({
    employee_id: z.string().trim().min(1),
    job_title: z.string().trim().min(1),
    department: z.string().trim().min(1),
    date_of_joining: dateYMD,
    reporting_manager_id: objectIdSchema.nullable().optional(),
    emergency_contact: emergencyContactSchema.optional(),
});

/**
 * The company-side profile. `company_name` (free text) is replaced by
 * `company_id` — a reference to `companies`. Admins creating a `client`
 * must name an existing company; there's no implicit create-by-typing,
 * which is exactly how near-duplicate companies used to appear.
 */
const clientProfileCreateSchema = z.object({
    company_id: z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId'),
    point_of_contact: z.string().trim().optional(),
    access_type: z.enum(['login', 'readonly_link']),
});

const roleEnum = z.enum([ROLES.ADMIN, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE, ROLES.CLIENT]);
const statusEnum = z.enum([USER_STATUSES.ACTIVE, USER_STATUSES.DEACTIVATED]);

// ─── POST /users ───────────────────────────────────────────────────────────

export const createUserBodySchema = z
    .object({
        email: z.string().trim().toLowerCase().email(),
        full_name: z.string().trim().min(1),
        phone: phoneSchema,
        role: roleEnum,
        timezone: timezoneSchema,
        slack_user_id: z.string().trim().optional(),
        initial_password: z.string().min(1, 'initial_password is required'),
        internal_profile: internalProfileCreateSchema.optional(),
        client_profile: clientProfileCreateSchema.optional(),
    })
    .superRefine((data, ctx) => {
        if (data.role === ROLES.CLIENT) {
            if (!data.client_profile) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['client_profile'],
                    message: 'client_profile is required for role=client',
                });
            }
            if (data.internal_profile) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['internal_profile'],
                    message: 'internal_profile must not be set for role=client',
                });
            }
        } else {
            if (!data.internal_profile) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['internal_profile'],
                    message: `internal_profile is required for role=${data.role}`,
                });
            }
            if (data.client_profile) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['client_profile'],
                    message: `client_profile must not be set for role=${data.role}`,
                });
            }
        }
    });

export type CreateUserBody = z.infer<typeof createUserBodySchema>;

// ─── PATCH /users/:id ──────────────────────────────────────────────────────
// Liberal schema: every field optional. Field-level authorization (admin vs
// self) is enforced in the service layer.

const internalProfilePatchSchema = internalProfileCreateSchema.partial();
const clientProfilePatchSchema = clientProfileCreateSchema.partial();

export const updateUserBodySchema = z
    .object({
        full_name: z.string().trim().min(1).optional(),
        phone: phoneSchema,
        timezone: timezoneSchema,
        slack_user_id: z.string().trim().nullable().optional(),
        slack_notifications_enabled: z.boolean().optional(),
        internal_profile: internalProfilePatchSchema.optional(),
        client_profile: clientProfilePatchSchema.optional(),
    })
    .refine((data) => Object.keys(data).length > 0, 'At least one field must be supplied');

export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

// ─── Path params ───────────────────────────────────────────────────────────

export const userIdParamSchema = z.object({
    id: objectIdSchema,
});

// ─── GET /users ────────────────────────────────────────────────────────────

// Whitelist of sortable fields. Anything outside this list is rejected at
// validation time so we never wire a Mongo query against an unindexed or
// PII-leaking column.
export const USER_SORT_FIELDS = ['full_name', 'email', 'role', 'status', 'created_at'] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

const sortParamSchema = z
    .string()
    .trim()
    .regex(/^\w+:(asc|desc)$/, 'sort must be `field:asc` or `field:desc`')
    .transform((raw) => {
        const [field, dir] = raw.split(':') as [string, 'asc' | 'desc'];
        return { field, dir };
    })
    .refine((parsed) => (USER_SORT_FIELDS as readonly string[]).includes(parsed.field), {
        message: `sort field must be one of ${USER_SORT_FIELDS.join('|')}`,
    });

export const listUsersQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        role: roleEnum.optional(),
        // Exclude users with this role. Used by surfaces that list "internal
        // staff only" (e.g. team timesheets picker should hide clients).
        // Mutually exclusive with `role`: if both are set we 400 rather than
        // silently picking one.
        exclude_role: roleEnum.optional(),
        status: statusEnum.optional(),
        // BUG-002 — when true, include soft-deleted (deactivated) users in the
        // result. Default false → list shows only active users. The controller
        // silently drops this if the caller lacks USER_WRITE so non-privileged
        // surfaces can't bypass the active-only default by setting the query.
        show_deleted: z
            .union([z.boolean(), z.literal('true'), z.literal('false')])
            .transform((v) => v === true || v === 'true')
            .optional()
            .default(false),
        // R15 — minimum 2 chars to avoid `?q=a` triggering a regex-on-collection scan.
        q: z.string().trim().min(2, 'q must be at least 2 characters').max(100).optional(),
        sort: sortParamSchema.optional(),
    })
    .strict()
    .refine((q) => !(q.role && q.exclude_role), {
        message: 'role and exclude_role cannot both be set',
        path: ['exclude_role'],
    });

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

// ─── POST /users/:id/change-role ───────────────────────────────────────────

export const changeRoleBodySchema = z.object({
    new_role: roleEnum,
});

export type ChangeRoleBody = z.infer<typeof changeRoleBodySchema>;

// ─── POST /users/:id/deactivate ────────────────────────────────────────────

export const deactivateUserBodySchema = z.object({
    reason: z.string().trim().min(1).max(500).optional(),
});

export type DeactivateUserBody = z.infer<typeof deactivateUserBodySchema>;

// ─── GET /users/assignable ─────────────────────────────────────────────────

export const assignableQuerySchema = z.object({
    role: roleEnum.optional(),
    /**
     * C6 — `project_id` is now REQUIRED. Pre-fix the route returned the
     * full non-client user directory (up to 500 users) to any
     * authenticated caller — CLIENT-role users included. Requiring
     * project scoping forces the caller to identify the project they're
     * picking assignees for; the service then verifies the caller has
     * read access to that project before returning its members.
     */
    project_id: objectIdSchema,
});

export type AssignableQuery = z.infer<typeof assignableQuerySchema>;

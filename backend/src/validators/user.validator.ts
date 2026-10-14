import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { ROLES } from '../constants/roles.js';
import { EMPLOYMENT_TYPES, USER_STATUSES } from '../constants/user-statuses.js';

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
/**
 * `undefined` = not supplied, `null` = clear it, anything else = a phone.
 *
 * The three used to collapse into two: an empty string was transformed to
 * `undefined`, which `updateUser` reads as "the patch didn't mention phone"
 * and skips. So clearing the field in the UI returned 200, said "saved", and
 * left the old number in the database — it reappeared on the next refresh.
 * `null` was refused outright by the bare `z.string()`, so there was no way
 * to remove a number once it had been set, from the UI or the API.
 */
const phoneSchema = z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v ? v : null))
    .refine(
        (v) => {
            if (v === undefined || v === null) return true;
            const parsed = parsePhoneNumberFromString(v);
            return parsed?.isValid() ?? false;
        },
        {
            message:
                "Enter a valid phone in international format ('+' followed by country code and digits) — length and digit count must match the country.",
        }
    )
    .transform((v) => {
        if (v === undefined || v === null) return v;
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

const employmentTypeEnum = z.enum([EMPLOYMENT_TYPES.STAFF, EMPLOYMENT_TYPES.FREELANCER]);

const emergencyContactSchema = z.object({
    name: z.string().trim().min(1),
    phone: z.string().trim().min(1),
    relation: z.string().trim().min(1),
});

/**
 * Treat an empty string as "not supplied".
 *
 * A form field the user left alone submits as `''`, not as an absent key —
 * so `.min(1).optional()` rejects it, because `optional()` admits `undefined`
 * and nothing else. That is precisely how the freelancer path broke: the API
 * accepted an omitted `employee_id` while the actual create form sent `''`
 * and got "Too small: expected string to have >=1 characters".
 *
 * Normalising here rather than asking every client to strip blanks keeps the
 * contract forgiving for any caller, and the per-employment-type requirement
 * still runs afterwards in the superRefine.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
    z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner.optional());

const internalProfileCreateSchema = z.object({
    // Optional in SHAPE, required per employment type in the superRefine on
    // `createUserBodySchema`: staff must supply all four, a freelancer none.
    // A freelancer is engaged, not employed — they have no employee number,
    // no job title, no department and no joining date, and forcing invented
    // values for them is what this relaxes.
    employee_id: blankAsAbsent(z.string().trim().min(1)),
    job_title: blankAsAbsent(z.string().trim().min(1)),
    department: blankAsAbsent(z.string().trim().min(1)),
    date_of_joining: blankAsAbsent(dateYMD),
    // Optional-with-default: every caller that predates the field (the demo
    // seeder, the smoke suite, existing integrations) keeps working and gets
    // `staff`, which is what they all meant.
    employment_type: employmentTypeEnum.default(EMPLOYMENT_TYPES.STAFF),
    // Shape stays nullable here; whether it may be EMPTY is decided per-role
    // in the superRefine below (required for everyone but the admin). Keeping
    // the field itself nullable is what lets the PATCH schema — which derives
    // from this one — still express "clear it" for an existing record.
    reporting_manager_id: objectIdSchema.nullable().optional(),
    emergency_contact: emergencyContactSchema.optional(),
    /** Redesign: developer type (Frontend, Backend, Mobile…); null clears it. */
    dev_type: z.string().trim().max(40).nullable().optional(),
});

/**
 * The company-side profile. `company_name` (free text) is replaced by
 * `company_id` — a reference to `companies`. Admins creating a `client`
 * must name an existing company; there's no implicit create-by-typing,
 * which is exactly how near-duplicate companies used to appear.
 */
const clientProfileCreateSchema = z.object({
    company_id: z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId'),
    access_type: z.enum(['login', 'readonly_link']),
    /** Job title at the client company, e.g. "CTO" (redesign). */
    title: z.string().trim().max(100).optional(),
});

const roleEnum = z.enum([ROLES.ADMIN, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE, ROLES.CLIENT]);

/**
 * Roles accepted by the LIST filters (`role`, `exclude_role`) — every role
 * that exists, including `representative`.
 *
 * Deliberately separate from `roleEnum`, which gates the create/update BODY.
 * `representative` was never added there and shouldn't be: a representative
 * is created through `POST /companies/:id/representatives`, which derives the
 * role and company server-side. Widening the write enum would open a second,
 * parallel way to mint one that skips those guarantees.
 *
 * Missing `representative` here is what made the staff directory's
 * `exclude_role=client` unable to hide them — the value was un-nameable, so
 * they sat among the internal staff and inflated the headcount.
 */
const filterRoleEnum = z.enum([
    ROLES.ADMIN,
    ROLES.MANAGER,
    ROLES.TEAM_LEAD,
    ROLES.EMPLOYEE,
    ROLES.CLIENT,
    ROLES.REPRESENTATIVE,
]);
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
            // Redesign (13 Oct 2026, the user's call): the staff record (employee id,
            // job title, department, joining date) and the reporting manager are
            // optional, because the new Add user form does not ask for them.
            // Cost, accepted: a person with no reporting manager shows on team
            // screens (leave approvals, team timesheets, attendance) for admins only
            // until one is set.
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

/**
 * PATCH shape. `.partial()` makes every field optional, and the four
 * staff-only fields additionally accept `null` to CLEAR them — which is what
 * switching someone from staff to freelancer has to do. Without it, the form
 * either sends `''` (rejected by `.min(1)`) or omits the keys, silently
 * leaving a freelancer carrying a stale job title and department.
 *
 * Same idiom `reporting_manager_id` already uses for "unset this".
 */
const internalProfilePatchSchema = internalProfileCreateSchema.partial().extend({
    employee_id: blankAsAbsent(z.string().trim().min(1).nullable()),
    job_title: blankAsAbsent(z.string().trim().min(1).nullable()),
    department: blankAsAbsent(z.string().trim().min(1).nullable()),
    date_of_joining: blankAsAbsent(dateYMD.nullable()),
});
// An update never moves a client contact to another company: that would leave them on the old
// company's project rosters. The company is set once, when the contact is created.
// Strict: a company_id is refused, not dropped (someone cannot be moved between companies).
const clientProfilePatchSchema = clientProfileCreateSchema.omit({ company_id: true }).partial().strict();

export const updateUserBodySchema = z
    .object({
        full_name: z.string().trim().min(1).optional(),
        /** Admins only (others have it stripped by the service): correct a user's sign-in email. */
        email: z.string().trim().toLowerCase().email().optional(),
        phone: phoneSchema,
        timezone: timezoneSchema,
        slack_user_id: z.string().trim().nullable().optional(),
        slack_notifications_enabled: z.boolean().optional(),
        email_notifications_enabled: z.boolean().optional(),
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
        role: filterRoleEnum.optional(),
        // Exclude users with these roles. Used by surfaces that list "internal
        // staff only" (e.g. the staff directory, the team timesheets picker).
        // Mutually exclusive with `role`: if both are set we 400 rather than
        // silently picking one.
        //
        // Accepts a comma-separated list. It was a single value, which is why
        // `exclude_role=client` silently left `representative` in the staff
        // directory — there was no way to name the second client-side role.
        // A bare single value still parses, so existing callers are unaffected.
        exclude_role: z
            .string()
            .transform((v) =>
                v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
            )
            .pipe(z.array(filterRoleEnum).min(1).max(10))
            .optional(),
        status: statusEnum.optional(),
        employment_type: employmentTypeEnum.optional(),
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

// ─── GET /users/photos ─────────────────────────────────────────────────────

/** Avatars on one screen, batched: `?ids=a,b,c` (max 200). */
export const USER_PHOTOS_MAX_IDS = 200;
export const userPhotosQuerySchema = z.object({
    ids: z
        .string()
        .transform((s) => [
            ...new Set(
                s
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean)
            ),
        ])
        .pipe(z.array(objectIdSchema).min(1).max(USER_PHOTOS_MAX_IDS)),
});
export type UserPhotosQuery = z.infer<typeof userPhotosQuerySchema>;

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

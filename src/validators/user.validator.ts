import { z } from 'zod';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';

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

const clientProfileCreateSchema = z.object({
    company_name: z.string().trim().min(1),
    point_of_contact: z.string().trim().optional(),
    access_type: z.enum(['login', 'readonly_link']),
});

const roleEnum = z.enum([ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.CLIENT]);
const statusEnum = z.enum([USER_STATUSES.ACTIVE, USER_STATUSES.DEACTIVATED]);

// ─── POST /users ───────────────────────────────────────────────────────────

export const createUserBodySchema = z
    .object({
        email: z.string().trim().toLowerCase().email(),
        full_name: z.string().trim().min(1),
        phone: z.string().trim().optional(),
        role: roleEnum,
        timezone: z.string().trim().optional(),
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
        phone: z.string().trim().optional(),
        timezone: z.string().trim().optional(),
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

export const listUsersQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    role: roleEnum.optional(),
    status: statusEnum.optional(),
    // R15 — minimum 2 chars to avoid `?q=a` triggering a regex-on-collection scan.
    q: z.string().trim().min(2, 'q must be at least 2 characters').max(100).optional(),
}).strict();

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
     * When supplied, the response is restricted to users in the project's
     * `member_ids[]` (i.e. people who can actually be assigned to a task /
     * sprint within that project). Omit for a global assignee picker.
     */
    project_id: objectIdSchema.optional(),
});

export type AssignableQuery = z.infer<typeof assignableQuerySchema>;

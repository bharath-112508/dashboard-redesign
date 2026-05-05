import { z } from 'zod';

import { PERMISSION_VALUES, type Permission } from '../constants/permissions.js';

/**
 * Zod schemas for the Step-47 Phase C role-CRUD surface and the
 * companion `PATCH /users/:id/roles` assignment endpoint.
 *
 * Conventions:
 *  - `key` follows the same regex as the Mongoose schema
 *    (`/^[a-z][a-z0-9_-]{0,39}$/`) — kept in sync explicitly so the
 *    service can reject a bad key with `VALIDATION_ERROR` (400) before
 *    the DB layer would turn it into a 500.
 *  - `permissions[]` is allowlist-validated against the full
 *    `PERMISSION_VALUES` set. The `system.admin` wildcard passes the
 *    allowlist here — the service rejects it on save with
 *    `ROLE_INVALID_PERMISSIONS` (only the seeded Admin role holds it).
 *  - `display_name` and `description` mirror the model's `maxlength`
 *    so a too-long input fails fast at 400, not at the Mongo write.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

const roleKeySchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(
        /^[a-z][a-z0-9_-]{0,39}$/,
        'Role key must start with a letter, contain only lowercase a-z / 0-9 / _ / -, and be 1-40 chars'
    );

const displayNameSchema = z.string().trim().min(1).max(100);
const descriptionSchema = z.string().trim().max(500);

const permissionListSchema = z
    .array(z.string())
    .min(1, 'At least one permission is required')
    .max(PERMISSION_VALUES.length)
    .refine(
        (perms) => {
            const allowed = new Set<string>(PERMISSION_VALUES);
            return perms.every((p) => allowed.has(p));
        },
        {
            message: `permissions must be drawn from the catalog (${PERMISSION_VALUES.length} entries)`,
        }
    )
    .transform((perms) => Array.from(new Set(perms)) as Permission[]);

// ─── POST /roles ────────────────────────────────────────────────────────

export const createRoleBodySchema = z.object({
    key: roleKeySchema,
    display_name: displayNameSchema,
    description: descriptionSchema.optional().default(''),
    permissions: permissionListSchema,
});

export type CreateRoleBody = z.infer<typeof createRoleBodySchema>;

// ─── PATCH /roles/:id ───────────────────────────────────────────────────
//
// `key` and `is_system` are **not** patchable. Custom roles can change
// their display name / description / permission set; system roles can
// change display name / description / permissions but never the key
// — the service enforces it (validator just refuses to accept the
// fields).

export const patchRoleBodySchema = z
    .object({
        display_name: displayNameSchema,
        description: descriptionSchema,
        permissions: permissionListSchema,
    })
    .partial()
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one of display_name / description / permissions must be supplied',
    });

export type PatchRoleBody = z.infer<typeof patchRoleBodySchema>;

// ─── GET /roles ─────────────────────────────────────────────────────────

export const listRolesQuerySchema = z.object({
    is_system: z
        .union([z.literal('true'), z.literal('false'), z.boolean()])
        .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
        .optional(),
});

export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;

// ─── PATCH /users/:user_id/roles ────────────────────────────────────────

export const assignRolesBodySchema = z.object({
    role_ids: z
        .array(objectIdSchema)
        .min(1, 'At least one role_id is required (a user with zero roles cannot do anything)')
        // Same cap as PERMISSION_VALUES so the JWT permission union stays bounded.
        .max(PERMISSION_VALUES.length)
        .transform((ids) => Array.from(new Set(ids))),
});

export type AssignRolesBody = z.infer<typeof assignRolesBodySchema>;

// ─── PATCH /users/:user_id/extra-permissions ────────────────────────────
//
// Pattern B (Step 47 follow-up). A replacement-style write: the
// supplied list IS the new `extra_permissions[]` value. To clear all
// extras, send `{ extra_permissions: [] }`.

export const updateExtraPermissionsBodySchema = z.object({
    extra_permissions: z
        .array(z.string())
        .max(PERMISSION_VALUES.length)
        .refine(
            (perms) => {
                const allowed = new Set<string>(PERMISSION_VALUES);
                return perms.every((p) => allowed.has(p));
            },
            {
                message: `extra_permissions must be drawn from the catalog (${PERMISSION_VALUES.length} entries)`,
            }
        )
        .transform((perms) => Array.from(new Set(perms)) as Permission[]),
});

export type UpdateExtraPermissionsBody = z.infer<typeof updateExtraPermissionsBodySchema>;

// ─── Path params ────────────────────────────────────────────────────────

export const roleIdParamSchema = z.object({
    id: objectIdSchema,
});

export type RoleIdParam = z.infer<typeof roleIdParamSchema>;

export const userIdParamSchema = z.object({
    user_id: objectIdSchema,
});

export type UserIdParam = z.infer<typeof userIdParamSchema>;

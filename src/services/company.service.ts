import { Types } from 'mongoose';

import { Company, type CompanyDocument } from '../models/company.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { PROJECT_CLIENT_SIDE_ROLES } from '../constants/project.js';
import { hashPassword } from '../utils/password.js';
import { assertPasswordPolicy } from '../utils/password-policy.js';
import { isAdminLike } from '../utils/role-check.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { deactivateUser } from './user.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateCompanyBody,
    CreateRepresentativeBody,
    ListCompaniesQuery,
    PatchCompanyBody,
} from '../validators/company.validator.js';

type Filter = Record<string, unknown>;

/**
 * Companies service — the client organisation.
 *
 * Vocabulary: **"Client" IS the company** (the company-level role);
 * a **"Representative"** is that company's project-scoped person.
 *
 *  - Archive, never hard-delete: projects carry `company_id` and historic
 *    references must stay resolvable.
 *  - `name` is unique case-insensitively (collated index). Every query that
 *    needs the index must pass the SAME collation — Mongo won't use a
 *    collated index for an uncollated query.
 */

const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

export interface CompanyCaller {
    id: Types.ObjectId;
    role: string;
    role_keys?: readonly string[];
    /** The caller's own company — set for client-side roles only. */
    company_id?: Types.ObjectId;
    audit?: AuditContext;
}

const toPublic = (doc: CompanyDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const isNameDuplicateError = (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: number; keyPattern?: Record<string, unknown> };
    return e.code === 11000 && Boolean(e.keyPattern?.name);
};

const loadCompanyOrThrow = async (id: Types.ObjectId): Promise<CompanyDocument> => {
    const doc = await Company.findById(id);
    if (!doc) throw AppError.notFound('Company not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    return doc;
};

/**
 * A `client` may only act on their OWN company. RBAC grants the verb
 * ("may create representatives"); it cannot express the scope ("for their
 * own company only"), so that check has to live here.
 */
const assertCallerOwnsCompany = (companyId: Types.ObjectId, caller: CompanyCaller): void => {
    if (isAdminLike(caller)) return;
    if (caller.company_id && caller.company_id.equals(companyId)) return;
    throw AppError.forbidden('You do not have access to this company', ERROR_CODES.FORBIDDEN);
};

// ─── POST /companies ─────────────────────────────────────────────────────

export const createCompany = async (
    input: CreateCompanyBody,
    caller: CompanyCaller
): Promise<Record<string, unknown>> => {
    let created: CompanyDocument;
    try {
        created = await Company.create({ name: input.name, created_by: caller.id });
    } catch (err) {
        if (isNameDuplicateError(err)) {
            throw AppError.conflict('A company with this name already exists', ERROR_CODES.DUPLICATE_RESOURCE, {
                name: input.name,
            });
        }
        throw err;
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.COMPANY_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.COMPANY, id: created._id },
            after: { name: created.name, status: created.status },
        });
    }
    return toPublic(created);
};

// ─── GET /companies ──────────────────────────────────────────────────────

export const listCompanies = async (
    query: ListCompaniesQuery,
    caller: CompanyCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Filter = {};
    if (query.status) filter.status = query.status;
    if (query.q) filter.name = { $regex: query.q, $options: 'i' };

    // A client-side caller only ever sees their own company. Without this
    // they'd get the full customer list — every other client's name.
    if (!isAdminLike(caller) && PROJECT_CLIENT_SIDE_ROLES.includes(caller.role)) {
        if (!caller.company_id) return { data: [], meta: { page: 1, limit: query.limit, total: 0, total_pages: 0 } };
        filter._id = caller.company_id;
    }

    const [rows, total] = await Promise.all([
        Company.find(filter)
            .collation(NAME_COLLATION)
            .sort({ name: 1 })
            .skip((query.page - 1) * query.limit)
            .limit(query.limit),
        Company.countDocuments(filter),
    ]);

    return {
        data: rows.map(toPublic),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.ceil(total / query.limit),
        },
    };
};

// ─── GET /companies/:id ──────────────────────────────────────────────────

export const getCompany = async (id: Types.ObjectId, caller: CompanyCaller): Promise<Record<string, unknown>> => {
    const doc = await loadCompanyOrThrow(id);
    assertCallerOwnsCompany(doc._id, caller);
    return toPublic(doc);
};

// ─── PATCH /companies/:id ────────────────────────────────────────────────

export const patchCompany = async (
    id: Types.ObjectId,
    body: PatchCompanyBody,
    caller: CompanyCaller
): Promise<Record<string, unknown>> => {
    const doc = await loadCompanyOrThrow(id);
    const before = { name: doc.name, status: doc.status };

    if (body.name !== undefined) doc.name = body.name;
    if (body.status !== undefined) doc.status = body.status as CompanyDocument['status'];

    try {
        await doc.save();
    } catch (err) {
        if (isNameDuplicateError(err)) {
            throw AppError.conflict('A company with this name already exists', ERROR_CODES.DUPLICATE_RESOURCE, {
                name: body.name,
            });
        }
        throw err;
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.COMPANY_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.COMPANY, id: doc._id },
            before,
            after: { name: doc.name, status: doc.status },
        });
    }
    return toPublic(doc);
};

// ─── POST /companies/:id/archive ─────────────────────────────────────────

export const archiveCompany = async (id: Types.ObjectId, caller: CompanyCaller): Promise<Record<string, unknown>> => {
    const doc = await loadCompanyOrThrow(id);
    if (doc.status === 'archived') return toPublic(doc);

    doc.status = 'archived';
    await doc.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.COMPANY_ARCHIVE,
            target: { kind: AUDIT_TARGET_KINDS.COMPANY, id: doc._id },
            before: { status: 'active' },
            after: { status: 'archived' },
        });
    }
    return toPublic(doc);
};

// ─── GET /companies/:id/representatives ──────────────────────────────────

export const listRepresentatives = async (
    id: Types.ObjectId,
    caller: CompanyCaller
): Promise<Record<string, unknown>[]> => {
    await loadCompanyOrThrow(id);
    assertCallerOwnsCompany(id, caller);

    const rows = await User.find({
        role: { $in: PROJECT_CLIENT_SIDE_ROLES },
        'client_profile.company_id': id,
    })
        .select('_id full_name email role status')
        .sort({ full_name: 1 })
        .lean<
            {
                _id: Types.ObjectId;
                full_name: string;
                email: string;
                role: string;
                status: string;
            }[]
        >();

    return rows.map((u) => ({
        id: u._id.toString(),
        full_name: u.full_name,
        email: u.email,
        // `client` = company-level, `representative` = assigned-only. The
        // distinction is the whole point of the roster, so it's surfaced.
        role: u.role,
        status: u.status,
    }));
};

// ─── DELETE /companies/:id/representatives/:user_id ──────────────────────

/**
 * Remove someone from a company.
 *
 * "Remove" means **deactivate** — `client_profile.company_id` is required,
 * so a client-side user can't exist without a company; there is no unlink
 * that leaves a valid account. Deactivation is the platform's soft-delete:
 * login revoked, history kept, reversible by an admin.
 *
 * **Why this exists instead of `POST /users/:id/deactivate`:** that route is
 * gated on `user.deactivate`, an admin-wide bit — giving it to a Client so
 * they could remove their own people would let them deactivate **anyone**,
 * admins included. Same shape of hazard as `user.write` on creation, same
 * fix: a scoped route that can only reach this company.
 *
 * A non-admin caller may remove **representatives only**. Letting a Client
 * remove other company-level Clients (or themselves) risks locking the
 * company out of managing its own people, recoverable only by an admin.
 */
export const removeRepresentative = async (
    companyId: Types.ObjectId,
    userId: Types.ObjectId,
    caller: CompanyCaller
): Promise<Record<string, unknown>> => {
    const company = await loadCompanyOrThrow(companyId);
    assertCallerOwnsCompany(company._id, caller);

    const target = await User.findById(userId).select('_id role status client_profile').lean<{
        _id: Types.ObjectId;
        role: string;
        status: string;
        client_profile?: { company_id?: Types.ObjectId };
    } | null>();

    // Scope the 404 to this company: an id belonging to another company is
    // "not found here", not "forbidden" — no cross-company enumeration.
    if (
        !target ||
        !PROJECT_CLIENT_SIDE_ROLES.includes(target.role) ||
        !target.client_profile?.company_id?.equals(company._id)
    ) {
        throw AppError.notFound('No such person in this company', ERROR_CODES.USER_NOT_FOUND);
    }

    if (!isAdminLike(caller) && target.role !== ROLES.REPRESENTATIVE) {
        throw AppError.forbidden('Only an administrator can remove a company-level client', ERROR_CODES.FORBIDDEN);
    }

    // `deactivateUser` also blocks self-removal, revokes refresh tokens,
    // cascades share-link revocation for clients, and writes the audit row.
    return deactivateUser({
        target_id: target._id,
        caller_id: caller.id,
        reason: 'removed_from_company',
        audit: caller.audit,
    });
};

// ─── POST /companies/:id/representatives ─────────────────────────────────

/**
 * Create a representative for a company.
 *
 * **Why this exists instead of `POST /users`:** creating a representative
 * creates a `User`. `POST /users` is gated on `user.write`, the admin-wide
 * bit — granting that to a Client so they could add their own people would
 * also let them create **admins**. This route is gated on
 * `representative.write` instead and derives the two dangerous fields
 * server-side:
 *
 *   - `role` is hard-coded to `representative` — never read from the body.
 *   - `company_id` comes from the URL, which `assertCallerOwnsCompany`
 *     pins to the caller's own company for a non-admin.
 *
 * The body schema is `.strict()`, so a request that even *mentions* `role`
 * or `company_id` is rejected at the validator rather than ignored quietly.
 */
export const createRepresentative = async (
    companyId: Types.ObjectId,
    input: CreateRepresentativeBody,
    caller: CompanyCaller
): Promise<Record<string, unknown>> => {
    const company = await loadCompanyOrThrow(companyId);
    assertCallerOwnsCompany(company._id, caller);

    if (company.status === 'archived') {
        throw AppError.unprocessable('Cannot add representatives to an archived company', ERROR_CODES.VALIDATION_ERROR);
    }

    assertPasswordPolicy(input.initial_password);

    const emailInUse = await User.exists({ email: input.email });
    if (emailInUse) {
        throw AppError.conflict('Email already exists', ERROR_CODES.EMAIL_ALREADY_EXISTS);
    }

    const password_hash = await hashPassword(input.initial_password);

    const created = await User.create({
        email: input.email,
        password_hash,
        full_name: input.full_name,
        phone: input.phone,
        // Hard-coded. Never `input.role` — there is no such field, and the
        // strict schema rejects a body that tries to introduce one.
        role: ROLES.REPRESENTATIVE,
        status: USER_STATUSES.ACTIVE,
        timezone: input.timezone,
        client_profile: {
            // From the URL + ownership check, never from the body.
            company_id: company._id,
            access_type: 'login',
        },
        created_by: caller.id,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.REPRESENTATIVE_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: created._id },
            after: {
                email: created.email,
                role: created.role,
                company_id: company._id.toString(),
            },
        });
    }

    const json = created.toJSON() as unknown as Record<string, unknown>;
    // Internal storage pointer — never part of the public surface.
    delete json.profile_photo_blob_key;
    return json;
};

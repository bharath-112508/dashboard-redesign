import { Types } from 'mongoose';

import { Engagement, type EngagementDocument } from '../models/engagement.model.js';
import { Company } from '../models/company.model.js';
import { Project } from '../models/project.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateEngagementInput,
    ListEngagementsQuery,
    UpdateEngagementInput,
} from '../validators/engagement.validator.js';

/**
 * Engagement service — Phase 1 "Client Engagements & Invoicing" Task 4.
 * Mirrors `billing-rate.service.ts`'s structure (caller shape, `toPublic`,
 * `loadOr404`, batched display hydration on list).
 *
 * Write-side invariants enforced here (the model is pure storage):
 *
 *   1. `company_id` must reference an existing `Company`.
 *   2. When `project_ids` is non-empty, every project must belong to the
 *      SAME company (`project.company_id.equals(engagement.company_id)`) —
 *      an engagement can't straddle two companies' projects. `[]` means
 *      "all of the company's projects", so an empty array always passes.
 *   3. `endEngagement` is idempotent: ending an already-ended engagement is
 *      a no-op success (same rationale as `billing-rate.service.ts#endRate`
 *      — a re-click shouldn't move `end_date` forward and re-open a window
 *      that was already closed for billing purposes).
 *
 * Audit: every mutation records a row via `recordAudit` (never throws).
 */

// ─── Caller shape ────────────────────────────────────────────────────────

export interface EngagementCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const toPublic = (doc: EngagementDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const todayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

const loadOr404 = async (id: Types.ObjectId): Promise<EngagementDocument> => {
    const engagement = await Engagement.findById(id);
    if (!engagement) throw AppError.notFound('Engagement not found', ERROR_CODES.ENGAGEMENT_NOT_FOUND);
    return engagement;
};

/**
 * Verify every project in `projectIds` exists AND belongs to `companyId`.
 * `[]` is a no-op (an engagement with no explicit `project_ids` covers all
 * of the company's projects). Single batched `Project.find` — no N+1 even
 * when the caller passes a long list.
 */
const assertProjectsScopedToCompany = async (
    companyId: Types.ObjectId,
    projectIds: Types.ObjectId[]
): Promise<void> => {
    if (projectIds.length === 0) return;

    const projects = await Project.find({ _id: { $in: projectIds } })
        .select('_id company_id')
        .lean<{ _id: Types.ObjectId; company_id: Types.ObjectId | null }[]>();

    const foundIds = new Set(projects.map((p) => p._id.toString()));
    const missing = projectIds.filter((id) => !foundIds.has(id.toString()));
    if (missing.length > 0) {
        throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    }

    const mismatched = projects.filter((p) => !p.company_id || !p.company_id.equals(companyId));
    if (mismatched.length > 0) {
        throw AppError.unprocessable(
            'All project_ids must belong to the engagement company',
            ERROR_CODES.ENGAGEMENT_INVALID_SCOPE,
            { project_ids: mismatched.map((p) => p._id.toString()) }
        );
    }
};

// ─── POST /engagements ───────────────────────────────────────────────────

export const createEngagement = async (
    input: CreateEngagementInput,
    caller: EngagementCaller
): Promise<Record<string, unknown>> => {
    const companyOid = new Types.ObjectId(input.company_id);
    const companyExists = await Company.exists({ _id: companyOid });
    if (!companyExists) throw AppError.notFound('Company not found', ERROR_CODES.RESOURCE_NOT_FOUND);

    const projectOids = (input.project_ids ?? []).map((id) => new Types.ObjectId(id));
    await assertProjectsScopedToCompany(companyOid, projectOids);

    const created = await Engagement.create({
        company_id: companyOid,
        project_ids: projectOids,
        name: input.name,
        currency: input.currency.toUpperCase(),
        billing_type: input.billing_type,
        setup_fee: input.setup_fee ?? null,
        retainer_amount: input.retainer_amount ?? null,
        retainer_period: input.retainer_period ?? null,
        included_hours: input.included_hours ?? null,
        fixed_amount: input.fixed_amount ?? null,
        start_date: input.start_date,
        end_date: input.end_date ?? null,
        notes: input.notes ?? '',
        created_by: caller.id,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.ENGAGEMENT_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.ENGAGEMENT, id: created._id },
            after: toPublic(created),
            metadata: {
                company_id: companyOid.toString(),
                project_ids: projectOids.map((id) => id.toString()),
            },
        });
    }

    return toPublic(created);
};

// ─── GET /engagements/:id ────────────────────────────────────────────────

export const getEngagement = async (id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const engagement = await loadOr404(id);
    return toPublic(engagement);
};

// ─── PATCH /engagements/:id ──────────────────────────────────────────────

export const updateEngagement = async (
    id: Types.ObjectId,
    patch: UpdateEngagementInput,
    caller: EngagementCaller
): Promise<Record<string, unknown>> => {
    const engagement = await loadOr404(id);
    const before = toPublic(engagement);

    if (patch.project_ids !== undefined) {
        const projectOids = patch.project_ids.map((pid) => new Types.ObjectId(pid));
        await assertProjectsScopedToCompany(engagement.company_id, projectOids);
        engagement.project_ids = projectOids;
    }
    if (patch.name !== undefined) engagement.name = patch.name;
    if (patch.setup_fee !== undefined) engagement.setup_fee = patch.setup_fee;
    if (patch.retainer_amount !== undefined) engagement.retainer_amount = patch.retainer_amount;
    if (patch.retainer_period !== undefined) engagement.retainer_period = patch.retainer_period;
    if (patch.included_hours !== undefined) engagement.included_hours = patch.included_hours;
    if (patch.fixed_amount !== undefined) engagement.fixed_amount = patch.fixed_amount;

    // A PATCH body never carries `start_date`, so the validator's cross-field
    // refine (create-time only) can't catch `end_date < start_date` here — the
    // service is the only place that still has both values. `null` (clearing
    // end_date) is always allowed.
    if (patch.end_date !== undefined && patch.end_date !== null && patch.end_date < engagement.start_date) {
        throw AppError.unprocessable('end_date must be on or after start_date', ERROR_CODES.ENGAGEMENT_INVALID_RANGE, {
            start_date: engagement.start_date,
            end_date: patch.end_date,
        });
    }
    if (patch.end_date !== undefined) engagement.end_date = patch.end_date;
    if (patch.notes !== undefined) engagement.notes = patch.notes;

    await engagement.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.ENGAGEMENT_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.ENGAGEMENT, id: engagement._id },
            before,
            after: toPublic(engagement),
        });
    }

    return toPublic(engagement);
};

// ─── POST /engagements/:id/end ───────────────────────────────────────────

export const endEngagement = async (id: Types.ObjectId, caller: EngagementCaller): Promise<Record<string, unknown>> => {
    const engagement = await loadOr404(id);

    // Idempotent — re-ending an already-ended engagement is a no-op
    // success rather than moving `end_date` forward (same rationale as
    // `billing-rate.service.ts#endRate`).
    if (engagement.status === 'ended') {
        return toPublic(engagement);
    }

    const before = toPublic(engagement);

    engagement.end_date = todayLocal();
    engagement.status = 'ended';
    await engagement.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.ENGAGEMENT_END,
            target: { kind: AUDIT_TARGET_KINDS.ENGAGEMENT, id: engagement._id },
            before,
            after: toPublic(engagement),
        });
    }

    return toPublic(engagement);
};

// ─── GET /engagements ────────────────────────────────────────────────────

/**
 * Per-page display hydration — mirrors `listRates`'s user/project/task
 * hydration so the admin engagements UI can render the company name
 * without N+1 lookups.
 */
interface EngagementCompanyDisplay {
    id: string;
    name: string | null;
}

const loadEngagementCompanyDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, EngagementCompanyDisplay>> => {
    if (ids.length === 0) return new Map();
    const companies = await Company.find({ _id: { $in: ids } })
        .select('_id name')
        .lean<{ _id: Types.ObjectId; name: string }[]>();
    return new Map(companies.map((c) => [c._id.toString(), { id: c._id.toString(), name: c.name }]));
};

export const listEngagements = async (
    query: ListEngagementsQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};
    if (query.company_id) filter.company_id = new Types.ObjectId(query.company_id);
    if (query.status) filter.status = query.status;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        Engagement.find(filter).sort({ created_at: -1, _id: -1 }).skip(skip).limit(query.limit),
        Engagement.countDocuments(filter),
    ]);

    const companyIds = Array.from(new Set(rows.map((r) => r.company_id.toString()))).map(
        (id) => new Types.ObjectId(id)
    );
    const companyMap = await loadEngagementCompanyDisplays(companyIds);

    return {
        data: rows.map((r) => {
            const obj = toPublic(r);
            obj.company = companyMap.get(r.company_id.toString()) ?? {
                id: r.company_id.toString(),
                name: null,
            };
            return obj;
        }),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

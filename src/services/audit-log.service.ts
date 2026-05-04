import { Types } from 'mongoose';

import { AuditLog, type AuditLogDocument } from '../models/audit-log.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { ListAuditLogsQuery } from '../validators/audit-log.validator.js';

/**
 * Audit-log read service (Step 31; API_Contract §12).
 *
 * Read-only — append-only writes happen in `audit.service`. This module
 * never mutates `audit_logs` and is admin-only at the route layer.
 *
 * Index alignment (Data_Model §7.2 / `audit-log.model.ts`):
 *  - `{ created_at: -1 }`                                    — global recency
 *  - `{ actor_id: 1, created_at: -1 }`                       — `actor_id` filter
 *  - `{ target_entity.kind, target_entity.id, created_at }`  — target filter
 *  - `{ action: 1, created_at: -1 }`                         — action filter
 *
 * Every supported filter combination is on-index. The validator enforces
 * `target_kind` whenever `target_id` is provided so a target-only query
 * can never bypass the composite index.
 *
 * Why the list endpoint strips snapshots:
 *  - `before` / `after` are capped at 16 KiB EACH per audit row. A
 *    100-row page with both populated could exceed 3 MB which would
 *    blow past most reverse-proxy timeouts. The list returns a
 *    summary; callers needing a diff hit `GET /audit-logs/:id`.
 */

interface ActorDisplay {
    id: string;
    full_name: string | null;
}

export interface AuditLogListRow {
    id: string;
    action: string;
    actor: ActorDisplay | null;
    actor_role: string;
    target_entity: { kind: string; id: string | null };
    metadata: Record<string, unknown>;
    created_at: string;
}

export interface AuditLogDetail extends AuditLogListRow {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
}

// ─── Filter builder ─────────────────────────────────────────────────────

/**
 * Convert a YYYY-MM-DD string to the Date that represents 00:00:00.000
 * in the configured business timezone. Used for `from_date`.
 *
 * `created_at` is a UTC timestamp on the row, so we convert the local
 * day boundary to UTC before comparing — this is what an admin in IST
 * means when they ask for "logs since 2026-04-15".
 */
const toRangeStart = (isoDate: string): Date => dayjs.tz(isoDate, DEFAULT_TIMEZONE).startOf('day').toDate();

/**
 * Convert a YYYY-MM-DD string to the Date that represents 23:59:59.999
 * in the configured business timezone. Used for `to_date`. Inclusive
 * end-of-day so an admin filtering "to_date: 2026-04-15" sees
 * everything from that day.
 */
const toRangeEnd = (isoDate: string): Date => dayjs.tz(isoDate, DEFAULT_TIMEZONE).endOf('day').toDate();

const buildFilter = (query: ListAuditLogsQuery): Record<string, unknown> => {
    const filter: Record<string, unknown> = {};
    if (query.actor_id) filter.actor_id = new Types.ObjectId(query.actor_id);
    if (query.action) filter.action = query.action;
    if (query.target_kind) filter['target_entity.kind'] = query.target_kind;
    if (query.target_id) filter['target_entity.id'] = new Types.ObjectId(query.target_id);

    if (query.from_date || query.to_date) {
        const range: Record<string, Date> = {};
        if (query.from_date) range.$gte = toRangeStart(query.from_date);
        if (query.to_date) range.$lte = toRangeEnd(query.to_date);
        filter.created_at = range;
    }
    return filter;
};

// ─── Actor display hydration ────────────────────────────────────────────
//
// The audit row stores `actor_id` only. To save the FE from N+1 lookups
// against `/users/:id`, we batch-load the unique non-null actor ids per
// page into a Map and stamp `{id, full_name}` onto each row.

const loadActorDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, ActorDisplay>> => {
    if (ids.length === 0) return new Map();
    const rows = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(rows.map((r) => [r._id.toString(), { id: r._id.toString(), full_name: r.full_name }]));
};

const renderActor = (
    doc: Pick<AuditLogDocument, 'actor_id'>,
    actorMap: Map<string, ActorDisplay>
): ActorDisplay | null => {
    if (!doc.actor_id) return null;
    return (
        actorMap.get(doc.actor_id.toString()) ?? {
            id: doc.actor_id.toString(),
            full_name: null, // user has been hard-deleted (rare); preserve the id for forensics
        }
    );
};

const toListRow = (doc: AuditLogDocument, actorMap: Map<string, ActorDisplay>): AuditLogListRow => ({
    id: doc._id.toString(),
    action: doc.action,
    actor: renderActor(doc, actorMap),
    actor_role: doc.actor_role,
    target_entity: {
        kind: doc.target_entity.kind,
        id: doc.target_entity.id?.toString() ?? null,
    },
    metadata: doc.metadata ?? {},
    created_at: doc.created_at.toISOString(),
});

const toDetail = (doc: AuditLogDocument, actorMap: Map<string, ActorDisplay>): AuditLogDetail => ({
    ...toListRow(doc, actorMap),
    before: doc.before,
    after: doc.after,
});

// ─── Public API ─────────────────────────────────────────────────────────

export const listAuditLogs = async (
    query: ListAuditLogsQuery
): Promise<{ data: AuditLogListRow[]; meta: PaginationMeta }> => {
    const filter = buildFilter(query);
    const skip = (query.page - 1) * query.limit;

    // Drop snapshots from the list query — see file header. `metadata`
    // stays because it's bounded at 4 KiB and carries the at-a-glance
    // detail the admin UI uses for the row label (e.g. `mention_count`,
    // `previous_blob_key`, etc.).
    const [rows, total] = await Promise.all([
        AuditLog.find(filter).select('-before -after').sort({ created_at: -1, _id: -1 }).skip(skip).limit(query.limit),
        AuditLog.countDocuments(filter),
    ]);

    const actorIds = Array.from(
        new Set(rows.filter((r) => r.actor_id !== null).map((r) => (r.actor_id as Types.ObjectId).toString()))
    ).map((id) => new Types.ObjectId(id));

    const actorMap = await loadActorDisplays(actorIds);

    return {
        data: rows.map((r) => toListRow(r, actorMap)),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

export const getAuditLog = async (id: Types.ObjectId): Promise<AuditLogDetail> => {
    const doc = await AuditLog.findById(id);
    if (!doc) throw AppError.notFound('Audit log not found', ERROR_CODES.RESOURCE_NOT_FOUND);

    const actorIds = doc.actor_id ? [doc.actor_id] : [];
    const actorMap = await loadActorDisplays(actorIds);

    return toDetail(doc, actorMap);
};

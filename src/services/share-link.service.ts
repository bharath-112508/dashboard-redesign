import { randomBytes } from 'node:crypto';

import { Types } from 'mongoose';

import { ProjectShareLink, type ProjectShareLinkDocument } from '../models/project-share-link.model.js';
import { Project } from '../models/project.model.js';
import { Sprint } from '../models/sprint.model.js';
import { Story } from '../models/story.model.js';
import { Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import {
    SHARE_LINK_REVOKE_REASONS,
    SHARE_LINK_TOKEN_BYTES,
    SHARE_LINK_TOKEN_MAX_ATTEMPTS,
    type ShareLinkRevokeReason,
} from '../constants/share-link.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { sha256Hex } from '../utils/token-hash.js';
import logger from '../utils/logger.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { CreateShareLinkBody, ListShareLinksQuery } from '../validators/share-link.validator.js';

/**
 * Project share-link service — Data_Model.md §5.8 / API_Contract.md §7.5–7.6.
 *
 * Surface:
 *  - `listLinks` / `createLink` — manager + admin (route-gated).
 *  - `revokeLink` — admin only (route-gated). Sets `revoked_at`,
 *    `revoked_by`, `revoke_reason = "manual"`, then audits.
 *  - `resolveLink` — public, no auth. The token IS the credential.
 *    Returns `{ project, sprints, stories, tasks }` and bumps
 *    `last_accessed_at`. **410 GONE** on revoked or expired links.
 *  - `revokeLinksForDeactivatedClient` — internal helper invoked by
 *    `user.service.deactivateUser` when the target is a client.
 *    Reason `"client_deactivated"`, `revoked_by` is the deactivating
 *    admin so the audit row points at the human who triggered the
 *    cascade (not the link owner).
 *
 * Token generation:
 *  - 32 random bytes → base64url. ~256 bits of entropy.
 *  - Unique index on `token`; on the (astronomically unlikely) E11000,
 *    we retry with a fresh token up to `SHARE_LINK_TOKEN_MAX_ATTEMPTS`
 *    times before surfacing a 500. The retry loop is paranoia, not a
 *    real path.
 */

// ─── Caller shape ────────────────────────────────────────────────────────

export interface ShareLinkCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * C9 — Public projection. Strips both `token` (legacy plaintext that
 * the boot migration nulls out) and `token_hash` (the on-disk digest)
 * because neither is useful to API consumers and the hash being on
 * the wire is gratuitous. The raw token is only ever surfaced at
 * create time via `createLink` returning `{...toPublic(doc), token}`.
 */
const toPublic = (doc: ProjectShareLinkDocument): Record<string, unknown> => {
    const json = doc.toJSON() as Record<string, unknown>;
    delete json.token;
    delete json.token_hash;
    return json;
};

const generateToken = (): string => randomBytes(SHARE_LINK_TOKEN_BYTES).toString('base64url');

const isE11000 = (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false;
    return (err as { code?: number }).code === 11000;
};

const ensureProjectExists = async (projectId: Types.ObjectId): Promise<void> => {
    const exists = await Project.exists({ _id: projectId });
    if (!exists) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
};

const ensureClientExists = async (clientId: Types.ObjectId): Promise<void> => {
    const exists = await User.exists({
        _id: clientId,
        role: ROLES.CLIENT,
        status: USER_STATUSES.ACTIVE,
    });
    if (!exists) {
        throw AppError.unprocessable(
            'owner_client_id must reference an active client user',
            ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE,
            { user_id: clientId.toString() }
        );
    }
};

const isLinkLive = (
    link: ProjectShareLinkDocument,
    now: Date
): { live: true } | { live: false; reason: 'revoked' | 'expired' } => {
    if (link.revoked_at !== null) return { live: false, reason: 'revoked' };
    if (link.expires_at !== null && link.expires_at <= now) return { live: false, reason: 'expired' };
    return { live: true };
};

// ─── GET /projects/:project_id/share-links ───────────────────────────────

export const listLinks = async (
    projectId: Types.ObjectId,
    query: ListShareLinksQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    await ensureProjectExists(projectId);

    const filter: Record<string, unknown> = { project_id: projectId };
    if (query.active_only) {
        filter.revoked_at = null;
        filter.$or = [{ expires_at: null }, { expires_at: { $gt: new Date() } }];
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        ProjectShareLink.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        ProjectShareLink.countDocuments(filter),
    ]);

    return {
        data: rows.map(toPublic),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── POST /projects/:project_id/share-links ──────────────────────────────

export const createLink = async (
    projectId: Types.ObjectId,
    input: CreateShareLinkBody,
    caller: ShareLinkCaller
): Promise<Record<string, unknown>> => {
    await ensureProjectExists(projectId);

    const ownerClientId = input.owner_client_id ? new Types.ObjectId(input.owner_client_id) : null;
    if (ownerClientId) await ensureClientExists(ownerClientId);

    if (input.expires_at !== null && input.expires_at !== undefined && input.expires_at <= new Date()) {
        throw AppError.unprocessable('The expiry date must be in the future.', ERROR_CODES.VALIDATION_ERROR, {
            expires_at: input.expires_at,
        });
    }

    // Retry loop on the (vanishingly improbable) token collision. Each
    // attempt regenerates the token; the unique index turns a duplicate
    // into a deterministic E11000 we can catch. Post-C9 the uniqueness
    // is on `token_hash`, not `token`.
    let created: ProjectShareLinkDocument | null = null;
    let rawToken = '';
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < SHARE_LINK_TOKEN_MAX_ATTEMPTS; attempt += 1) {
        const candidate = generateToken();
        try {
            created = await ProjectShareLink.create({
                project_id: projectId,
                // C9 — persist only the hash; the raw token is returned
                // to the caller below and is never stored.
                token_hash: sha256Hex(candidate),
                token: null,
                owner_client_id: ownerClientId,
                created_by: caller.id,
                expires_at: input.expires_at ?? null,
                revoked_at: null,
                revoked_by: null,
                revoke_reason: null,
                last_accessed_at: null,
            });
            rawToken = candidate;
            break;
        } catch (err) {
            lastErr = err;
            if (!isE11000(err)) throw err;
            // Loop and try a new token.
        }
    }
    if (!created) {
        logger.error(
            { err: lastErr, code: 'SHARE_LINK_TOKEN_COLLISION_EXHAUSTED' },
            'Exhausted share-link token retries — extremely unlikely with 256 bits of entropy'
        );
        throw AppError.internal('Failed to generate a unique share-link token');
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SHARE_LINK_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.SHARE_LINK, id: created._id },
            // The audit row carries `toPublic` shape (no token, no
            // token_hash) so a forensic read of audit_logs doesn't
            // leak the credential either.
            after: toPublic(created),
            metadata: {
                project_id: projectId.toString(),
                owner_client_id: ownerClientId?.toString() ?? null,
                has_expiry: input.expires_at !== null && input.expires_at !== undefined,
            },
        });
    }

    // C9 — the raw token is returned EXACTLY ONCE on create. The admin
    // copies the URL out of the dialog; the FE list view never gets it
    // back (token_hash is one-way). If they lose the URL: revoke +
    // create new.
    return { ...toPublic(created), token: rawToken };
};

// ─── POST /share-links/:id/revoke ────────────────────────────────────────

const revokeOne = async (
    link: ProjectShareLinkDocument,
    revokedBy: Types.ObjectId | null,
    reason: ShareLinkRevokeReason,
    audit?: AuditContext
): Promise<void> => {
    const before = toPublic(link);
    link.revoked_at = new Date();
    link.revoked_by = revokedBy;
    link.revoke_reason = reason;
    await link.save();

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.SHARE_LINK_REVOKE,
            target: { kind: AUDIT_TARGET_KINDS.SHARE_LINK, id: link._id },
            before,
            after: toPublic(link),
            metadata: {
                project_id: link.project_id.toString(),
                owner_client_id: link.owner_client_id?.toString() ?? null,
                reason,
            },
        });
    }
};

export const revokeLink = async (id: Types.ObjectId, caller: ShareLinkCaller): Promise<Record<string, unknown>> => {
    const link = await ProjectShareLink.findById(id);
    if (!link) throw AppError.notFound('Share link not found', ERROR_CODES.SHARE_LINK_NOT_FOUND);

    // Idempotent — re-revoking an already-revoked link returns the row
    // unchanged rather than over-writing the original `revoked_at`.
    // Otherwise an admin double-clicking the revoke button could shift
    // the audit trail's "when did this stop working" boundary.
    if (link.revoked_at !== null) {
        return toPublic(link);
    }

    await revokeOne(link, caller.id, SHARE_LINK_REVOKE_REASONS.MANUAL, caller.audit);
    return toPublic(link);
};

// ─── GET /share-links/resolve/:token (public) ────────────────────────────

export interface ResolvedShareLinkPayload {
    project: Record<string, unknown>;
    sprints: Record<string, unknown>[];
    stories: Record<string, unknown>[];
    tasks: Record<string, unknown>[];
    /** When the link was last touched (now); reflects the post-update state. */
    last_accessed_at: Date;
    /** H19 — set when any collection hit its cap and was clipped.
     *  The FE renders a "showing N of M" warning when present. */
    truncated?: {
        sprints?: boolean;
        stories?: boolean;
        tasks?: boolean;
    };
}

/**
 * H19 — hard caps on the public share-link payload. The endpoint is
 * UNAUTHENTICATED, anyone-with-the-URL access, so an unbounded
 * `.find({ project_id })` on a large project rendered a multi-MB
 * JSON response per anonymous request — a usable DOS amplification
 * + heap-pressure vector. Caps sized to typical project shapes:
 *   - sprints: 50  (≈ 1 sprint / 2 weeks × 2 years)
 *   - stories: 100 (large product portfolios)
 *   - tasks:   1000 (matches REPORT_ROW_CAP)
 * The find queries pull `limit + 1` so we can detect overflow
 * without a second `countDocuments` round-trip.
 */
const SHARE_LINK_SPRINT_CAP = 50;
const SHARE_LINK_STORY_CAP = 100;
const SHARE_LINK_TASK_CAP = 1_000;

const docsToJson = <T extends { toJSON: () => unknown }>(rows: T[]): Record<string, unknown>[] =>
    rows.map((r) => r.toJSON() as Record<string, unknown>);

export const resolveLink = async (token: string): Promise<ResolvedShareLinkPayload> => {
    // C9 — look up by hash. The raw token from the URL is never compared
    // against a stored plaintext; we hash it (deterministic, fast) and
    // find the matching `token_hash`. Mirrors the password-reset
    // verification path.
    const link = await ProjectShareLink.findOne({ token_hash: sha256Hex(token) });
    if (!link) throw AppError.notFound('Share link not found', ERROR_CODES.SHARE_LINK_NOT_FOUND);

    const now = new Date();
    const status = isLinkLive(link, now);
    if (!status.live) {
        if (status.reason === 'revoked') {
            // `revoke_reason` is intentionally NOT echoed on the public
            // 410 — the literal value `client_deactivated` would
            // disclose to a token holder that a specific client account
            // was deactivated, which is a state we'd rather not leak
            // through an unauthenticated channel. The internal audit
            // log keeps the reason for ops + the Step-31 audit UI.
            throw AppError.gone('This share link has been revoked', ERROR_CODES.SHARE_LINK_REVOKED, {
                revoked_at: link.revoked_at,
            });
        }
        throw AppError.gone('This share link has expired', ERROR_CODES.SHARE_LINK_EXPIRED, {
            expires_at: link.expires_at,
        });
    }

    // Bump `last_accessed_at`. We deliberately don't audit every
    // access — the v1 spec says one timestamp is enough; per-visit
    // logs land in a future `share_link_accesses` collection if
    // needed (Data_Model §11 follow-up #3).
    link.last_accessed_at = now;
    await link.save();

    // Field projections strip the *enumeration vectors* — the bulk
    // ObjectId arrays of internal users (`member_ids`, `client_ids`,
    // `collaborator_ids`) and admin-history bookkeeping (`created_by`,
    // `updated_by`) — from the public payload. We keep
    // `primary_assignee_id` because the FE renders an avatar tile for
    // "who's working on this" and the cost is one ObjectId per task,
    // not a bulk list. This is the public surface; an authenticated
    // user reading the same project through `/projects/:id` gets the
    // full document.
    const project = await Project.findById(link.project_id).select('-member_ids -client_ids -created_by');
    if (!project) {
        // Project deleted while a link still exists. Treat as a stale
        // pointer — `404 SHARE_LINK_NOT_FOUND` is more honest than 500.
        throw AppError.notFound(
            'The project for this share link is no longer available',
            ERROR_CODES.SHARE_LINK_NOT_FOUND
        );
    }

    // H19 — pull `limit + 1` so we know whether the result was
    // clipped without an extra `countDocuments` round-trip.
    const [sprintsRaw, storiesRaw, tasksRaw] = await Promise.all([
        Sprint.find({ project_id: link.project_id })
            .select('-created_by')
            .sort({ start_date: 1, _id: 1 })
            .limit(SHARE_LINK_SPRINT_CAP + 1),
        Story.find({ project_id: link.project_id })
            .select('-created_by -updated_by')
            .sort({ order: 1, _id: 1 })
            .limit(SHARE_LINK_STORY_CAP + 1),
        Task.find({ project_id: link.project_id })
            .select('-collaborator_ids -created_by -updated_by')
            .sort({ status_order: 1, _id: 1 })
            .limit(SHARE_LINK_TASK_CAP + 1),
    ]);

    const sprintsClipped = sprintsRaw.length > SHARE_LINK_SPRINT_CAP;
    const storiesClipped = storiesRaw.length > SHARE_LINK_STORY_CAP;
    const tasksClipped = tasksRaw.length > SHARE_LINK_TASK_CAP;
    const truncated =
        sprintsClipped || storiesClipped || tasksClipped
            ? {
                  ...(sprintsClipped ? { sprints: true } : {}),
                  ...(storiesClipped ? { stories: true } : {}),
                  ...(tasksClipped ? { tasks: true } : {}),
              }
            : undefined;

    return {
        project: project.toJSON() as unknown as Record<string, unknown>,
        sprints: docsToJson(sprintsRaw.slice(0, SHARE_LINK_SPRINT_CAP)),
        stories: docsToJson(storiesRaw.slice(0, SHARE_LINK_STORY_CAP)),
        tasks: docsToJson(tasksRaw.slice(0, SHARE_LINK_TASK_CAP)),
        last_accessed_at: now,
        ...(truncated ? { truncated } : {}),
    };
};

// ─── Auto-revoke cascade (called from user.service.deactivateUser) ──────

/**
 * Best-effort revoke of every open share link owned by a client whose
 * account was just deactivated. Mirrors the audit/notification policy:
 *  - Returns the count revoked so the deactivate flow can include it
 *    on the audit metadata.
 *  - Each revoke is independently audited (one row per link) under
 *    `share_link.revoke` with `metadata.reason="client_deactivated"`,
 *    so the Step-31 audit UI can correlate them to the parent
 *    `user.deactivate` event by `revoked_by` + timestamp.
 *  - **Never throws** — a failure mid-cascade still leaves the user
 *    deactivated. Failures log under `SHARE_LINK_AUTO_REVOKE_FAILED`
 *    so an operator can grep for stuck rows and re-run.
 */
// ─── C9 boot migration: hash legacy plaintext tokens in place ────────────

/**
 * One-time migration invoked from `src/index.ts` on boot. Walks every
 * row whose legacy `token` field is set, computes `sha256Hex(token)`,
 * writes it to `token_hash`, and clears `token` to null. Idempotent —
 * a row with `token: null` (post-migration) is left alone, so reruns
 * are no-ops. Never throws — failures log under
 * `SHARE_LINK_TOKEN_MIGRATION_FAILED` so boot continues; the next
 * resolve against a still-plaintext row simply returns 404 (the
 * authentic in-DB hash won't match).
 *
 * Returns `{ migrated, failed }` for the boot log.
 */
export const migrateShareLinkTokensToHashed = async (): Promise<{
    migrated: number;
    failed: number;
}> => {
    let migrated = 0;
    let failed = 0;
    try {
        const legacy = await ProjectShareLink.find({
            token: { $type: 'string', $ne: null },
        }).select('_id token');
        for (const row of legacy) {
            try {
                if (!row.token) continue;
                row.token_hash = sha256Hex(row.token);
                row.token = null;
                await row.save();
                migrated += 1;
            } catch (err) {
                failed += 1;
                logger.warn(
                    {
                        err,
                        code: 'SHARE_LINK_TOKEN_MIGRATION_FAILED',
                        link_id: row._id.toString(),
                    },
                    'Failed to hash a legacy share-link token'
                );
            }
        }
        if (migrated > 0 || failed > 0) {
            logger.info({ migrated, failed }, 'Share-link token migration complete');
        }
    } catch (err) {
        logger.warn({ err, code: 'SHARE_LINK_TOKEN_MIGRATION_FAILED' }, 'Share-link token migration cursor failed');
    }
    return { migrated, failed };
};

export const revokeLinksForDeactivatedClient = async (input: {
    client_id: Types.ObjectId;
    revoked_by: Types.ObjectId;
    audit?: AuditContext;
}): Promise<{ revoked_count: number }> => {
    let revokedCount = 0;
    try {
        const open = await ProjectShareLink.find({
            owner_client_id: input.client_id,
            revoked_at: null,
        });
        for (const link of open) {
            try {
                await revokeOne(link, input.revoked_by, SHARE_LINK_REVOKE_REASONS.CLIENT_DEACTIVATED, input.audit);
                revokedCount += 1;
            } catch (err) {
                logger.warn(
                    {
                        err,
                        code: 'SHARE_LINK_AUTO_REVOKE_FAILED',
                        link_id: link._id.toString(),
                        client_id: input.client_id.toString(),
                    },
                    'Failed to auto-revoke share link during client deactivation'
                );
            }
        }
    } catch (err) {
        logger.warn(
            { err, code: 'SHARE_LINK_AUTO_REVOKE_FAILED', client_id: input.client_id.toString() },
            'Failed to load share links for client-deactivation cascade'
        );
    }
    return { revoked_count: revokedCount };
};

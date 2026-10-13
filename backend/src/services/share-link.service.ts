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
import { encryptSecret, decryptSecret } from '../utils/crypto-aes.js';
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
 * C9 — Public projection. Strips `token` (legacy plaintext), `token_hash`
 * (the on-disk digest), and `token_encrypted` (AES ciphertext) because
 * none of these are useful to API consumers. The raw token is only ever
 * surfaced at create time (once) and by the authed list via
 * `toPublicWithToken`. Never write ciphertext to audit_logs.
 */
const toPublic = (doc: ProjectShareLinkDocument): Record<string, unknown> => {
    const json = doc.toJSON() as Record<string, unknown>;
    delete json.token;
    delete json.token_hash;
    delete json.token_encrypted;
    return json;
};

/**
 * Like `toPublic` but also decrypts `token_encrypted` and attaches the
 * raw token as `token`. Used ONLY in `listLinks` (route-gated on
 * `share_link.write`) so authed admins can copy the share URL.
 *
 * Failure behaviour: a decrypt error (key rotation, truncated blob) logs
 * a warning under `SHARE_LINK_TOKEN_DECRYPT_FAILED` and returns
 * `token: null` so the list still renders — the Copy button simply stays
 * hidden for that row. Never throws.
 *
 * Legacy rows (created before `token_encrypted` was added) have
 * `token_encrypted: null`; those return `token: null` without any
 * decrypt attempt.
 */
const toPublicWithToken = (doc: ProjectShareLinkDocument): Record<string, unknown> => {
    const base = toPublic(doc);
    if (!doc.token_encrypted) {
        return { ...base, token: null };
    }
    try {
        const raw = decryptSecret(doc.token_encrypted);
        return { ...base, token: raw };
    } catch (err) {
        logger.warn(
            { err, code: 'SHARE_LINK_TOKEN_DECRYPT_FAILED', link_id: doc._id.toString() },
            'Failed to decrypt share-link token — returning null for this row'
        );
        return { ...base, token: null };
    }
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
        // toPublicWithToken decrypts token_encrypted so authed admins
        // can use the per-row Copy URL button. Decrypt failures surface
        // as token: null (never 500 the list).
        data: rows.map(toPublicWithToken),
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
                // to the caller below and is never stored in plaintext.
                token_hash: sha256Hex(candidate),
                // AES-256-GCM encrypted copy so authed admins can
                // recover the raw token for the Copy-URL action without
                // ever storing plaintext. Consistent with how the Slack
                // bot token is stored (same MFA_ENCRYPTION_KEY).
                token_encrypted: encryptSecret(candidate),
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

    // ALLOW-list, deliberately — not a deny-list.
    //
    // This is the public, unauthenticated surface. The projection used to
    // be `.select('-member_ids -client_ids -created_by')`, which fails
    // OPEN: any field later added to `Project` is exposed by default, and
    // merely RENAMING a denied field silently un-denies it. Renaming
    // `client_ids` → `representative_ids` would have leaked every
    // representative's user id to anyone holding a share token — exactly
    // the "enumeration vector" the old comment said it was blocking.
    //
    // An allow-list fails CLOSED: a new field is invisible here until
    // someone consciously adds it. `company_id` and `representative_ids`
    // are both omitted on purpose.
    //
    // An authenticated user reading the same project via `/projects/:id`
    // still gets the full document — this narrowing is public-only.
    const project = await Project.findById(link.project_id).select(
        'name code description status is_archived start_date end_date custom_task_statuses default_status_orders created_at updated_at'
    );
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
            // member_ids are staff ids: not for unauthenticated viewers.
            .select('-created_by -member_ids')
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
/**
 * Pre-C9 databases carry a non-sparse `unique` index on the legacy
 * `token` field. After C9 every new row persists `token: null`, and a
 * plain unique index permits only ONE null collection-wide — so the
 * second share link ever created collides on the stale index, gets
 * mistaken for a token collision, exhausts the retry loop, and 500s
 * ("Failed to generate a unique share-link token"). The C9 schema moved
 * uniqueness to `token_hash` but Mongoose never drops the old index, so
 * we drop it explicitly here. Idempotent + never-throw: a fresh DB that
 * never had the index, or a rerun, is a no-op.
 */
const LEGACY_TOKEN_INDEX = 'project_share_links_token_unique';

const dropLegacyTokenIndex = async (): Promise<boolean> => {
    try {
        const indexes = await ProjectShareLink.collection.indexes();
        if (!indexes.some((ix) => ix.name === LEGACY_TOKEN_INDEX)) return false;
        await ProjectShareLink.collection.dropIndex(LEGACY_TOKEN_INDEX);
        logger.info({ index: LEGACY_TOKEN_INDEX }, 'Dropped stale share-link token unique index (C9)');
        return true;
    } catch (err) {
        logger.warn(
            { err, code: 'SHARE_LINK_LEGACY_INDEX_DROP_FAILED', index: LEGACY_TOKEN_INDEX },
            'Failed to drop stale share-link token unique index'
        );
        return false;
    }
};

export const migrateShareLinkTokensToHashed = async (): Promise<{
    migrated: number;
    failed: number;
}> => {
    let migrated = 0;
    let failed = 0;
    // Drop the stale `{ token: 1 }` unique index before touching rows so
    // the null-token writes below (and all future creates) don't collide.
    await dropLegacyTokenIndex();
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

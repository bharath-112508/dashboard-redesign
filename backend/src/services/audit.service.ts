import { Types } from 'mongoose';

import { AuditLog } from '../models/audit-log.model.js';
import {
    AUDIT_METADATA_BYTES_MAX,
    AUDIT_SNAPSHOT_BYTES_MAX,
    type AuditAction,
    type AuditActorRole,
    type AuditTargetKind,
} from '../constants/audit.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import logger from '../utils/logger.js';
import { auditSnapshotDroppedTotal, auditWritesTotal } from '../utils/metrics.js';

/**
 * Audit-log service (Step 12 — write-only in Phase 1).
 *
 * `recordAudit` is the **only** way the rest of the codebase touches the
 * `audit_logs` collection. It:
 *
 *   1. Coerces the snapshot fields to plain JSON so Mongoose sub-docs aren't
 *      stored verbatim (which would re-attach `_id` virtuals on every read).
 *   2. Drops oversized snapshots so a single audit row can't blow past the
 *      collection's effective payload budget — when dropped, a small marker
 *      is added to `metadata` so an operator can see *something* was elided.
 *   3. **NEVER throws.** All failures are caught and logged at `warn` with
 *      the canonical `AUDIT_WRITE_FAILED` error code. The primary action
 *      that triggered the audit MUST always succeed even if the audit row
 *      can't be persisted (e.g. transient mongo failure) — the sensitive
 *      action itself is what users care about; the audit trail is best
 *      effort but extremely loud when it drops.
 *
 * The read surface lives in `audit-log.controller.ts` (Step 31 —
 * shipped). This service is intentionally write-only; the read path
 * is its own controller so the write hot-path stays small.
 */

// ─── Public types ────────────────────────────────────────────────────────

/**
 * Identifies the actor + their request context. Built once per HTTP request
 * by the controller layer (see `utils/audit-context.ts`) and threaded into
 * each service call that needs to audit.
 */
export interface AuditContext {
    actor_id: Types.ObjectId | null;
    actor_role: AuditActorRole;
    ip?: string | null;
    user_agent?: string | null;
    request_id?: string | null;
}

export interface RecordAuditInput {
    action: AuditAction | string;
    target: {
        kind: AuditTargetKind | string;
        id: Types.ObjectId | null;
        /**
         * Optional explicit human name for the target. When omitted,
         * `recordAudit` derives one from the before/after snapshot or
         * metadata (see `deriveTargetLabel`). Pass this when the best label
         * is known at the call site and isn't in the snapshot.
         */
        label?: string | null;
    };
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * Force a snapshot into plain JSON. Mongoose Documents and Subdocuments have
 * a `.toJSON()` we can call, otherwise we fall back to a JSON round-trip so
 * any class instances are reduced to data. Returns `null` on failure rather
 * than throwing — a malformed snapshot must not block the action.
 */
const toPlainJson = (value: unknown): Record<string, unknown> | null => {
    if (value === null || value === undefined) return null;
    try {
        const candidate = value as { toJSON?: () => unknown };
        if (typeof candidate.toJSON === 'function') {
            const json = candidate.toJSON();
            if (json && typeof json === 'object' && !Array.isArray(json)) {
                return json as Record<string, unknown>;
            }
        }
        // Round-trip strips Mongoose internals + class prototypes.
        const plain = JSON.parse(JSON.stringify(value));
        if (plain && typeof plain === 'object' && !Array.isArray(plain)) {
            return plain as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
};

/**
 * Snapshot fields (in priority order) that make a good human label for the
 * affected record. First non-empty string wins.
 */
const LABEL_SNAPSHOT_FIELDS = [
    'full_name',
    'display_name',
    'name',
    'title',
    'file_name',
    'code',
    'key',
    'email',
] as const;

/** Metadata fields to fall back to when the snapshot has no usable name. */
const LABEL_METADATA_FIELDS = ['key', 'job_name', 'name', 'title', 'code'] as const;

const TARGET_LABEL_MAX = 200;

const firstString = (source: Record<string, unknown> | null | undefined, fields: readonly string[]): string | null => {
    if (!source) return null;
    for (const f of fields) {
        const v = source[f];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
};

/**
 * Derive a short, human-readable name for the audited record so the read UI
 * can show "User — Jane Doe" instead of an opaque ObjectId. An explicit
 * `target.label` wins; otherwise we read the `after` snapshot (the record's
 * new state), then `before` (for deletes), then metadata. Returns null when
 * nothing usable is present (the UI falls back to the id). Derived from the
 * raw input BEFORE any size-based snapshot drop, so the label survives even
 * when the snapshot itself is elided.
 */
export const deriveTargetLabel = (input: RecordAuditInput): string | null => {
    const explicit = input.target.label;
    if (typeof explicit === 'string' && explicit.trim()) {
        return explicit.trim().slice(0, TARGET_LABEL_MAX);
    }
    const label =
        firstString(input.after ?? null, LABEL_SNAPSHOT_FIELDS) ??
        firstString(input.before ?? null, LABEL_SNAPSHOT_FIELDS) ??
        firstString(input.metadata ?? null, LABEL_METADATA_FIELDS);
    return label ? label.slice(0, TARGET_LABEL_MAX) : null;
};

/**
 * Returns `true` when serialising `obj` would exceed `maxBytes` UTF-8 bytes.
 * Cheap upper bound: `JSON.stringify` once and measure.
 */
const exceedsByteCap = (obj: Record<string, unknown> | null, maxBytes: number): boolean => {
    if (!obj) return false;
    try {
        return Buffer.byteLength(JSON.stringify(obj), 'utf8') > maxBytes;
    } catch {
        return true;
    }
};

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Persist a single audit row. Always returns a resolved promise — exceptions
 * from the underlying `AuditLog.create` call are converted to `warn` logs
 * tagged with `AUDIT_WRITE_FAILED` so the calling business action keeps its
 * 2xx status code.
 */
export const recordAudit = async (ctx: AuditContext, input: RecordAuditInput): Promise<void> => {
    const beforeJson = toPlainJson(input.before ?? null);
    const afterJson = toPlainJson(input.after ?? null);

    const beforeOverflow = exceedsByteCap(beforeJson, AUDIT_SNAPSHOT_BYTES_MAX);
    const afterOverflow = exceedsByteCap(afterJson, AUDIT_SNAPSHOT_BYTES_MAX);

    const metadata: Record<string, unknown> = {};
    if (ctx.ip) metadata.ip = ctx.ip;
    if (ctx.user_agent) metadata.user_agent = ctx.user_agent;
    if (ctx.request_id) metadata.request_id = ctx.request_id;
    if (input.metadata) {
        for (const [k, v] of Object.entries(input.metadata)) {
            if (v !== undefined) metadata[k] = v;
        }
    }
    if (beforeOverflow) {
        metadata.before_snapshot_dropped = true;
        // G4 — operator-visible signal beyond the per-row metadata flag.
        auditSnapshotDroppedTotal.inc({ which: 'before' });
    }
    if (afterOverflow) {
        metadata.after_snapshot_dropped = true;
        auditSnapshotDroppedTotal.inc({ which: 'after' });
    }

    // Last-resort guard: if metadata itself is oversized, strip user-provided
    // keys to keep IP/UA + the snapshot-drop flags only. (Keeps the row
    // useful even when callers stuff huge blobs in.)
    //
    // G4 — preserve `before_snapshot_dropped` / `after_snapshot_dropped`
    // across the strip carve-out. Pre-G4 the strip discarded everything
    // except `ip`/`user_agent`/`request_id`/`metadata_truncated`, so an
    // operator seeing a `metadata_truncated: true` row couldn't tell
    // whether the snapshot was dropped or simply absent (e.g. a
    // create event with no `before`).
    if (exceedsByteCap(metadata, AUDIT_METADATA_BYTES_MAX)) {
        const stripped: Record<string, unknown> = { metadata_truncated: true };
        if (typeof metadata.ip === 'string') stripped.ip = metadata.ip;
        if (typeof metadata.user_agent === 'string') stripped.user_agent = metadata.user_agent;
        if (typeof metadata.request_id === 'string') stripped.request_id = metadata.request_id;
        if (metadata.before_snapshot_dropped === true) stripped.before_snapshot_dropped = true;
        if (metadata.after_snapshot_dropped === true) stripped.after_snapshot_dropped = true;
        for (const k of Object.keys(metadata)) delete metadata[k];
        Object.assign(metadata, stripped);
    }

    // Derive the human label from the RAW input (before any snapshot drop)
    // so it survives even when the snapshot is elided for size.
    const targetLabel = deriveTargetLabel(input);

    try {
        await AuditLog.create({
            actor_id: ctx.actor_id,
            actor_role: ctx.actor_role,
            action: input.action,
            target_entity: { kind: input.target.kind, id: input.target.id, label: targetLabel },
            before: beforeOverflow ? null : beforeJson,
            after: afterOverflow ? null : afterJson,
            metadata,
        });
        auditWritesTotal.inc({ outcome: 'ok' });
    } catch (err) {
        auditWritesTotal.inc({ outcome: 'failed' });
        // Defence in depth — even a broken logger must not propagate. The
        // primary action (deactivate/approve/etc.) MUST succeed regardless,
        // so we belt-and-brace the warn call too.
        try {
            logger.warn(
                {
                    err,
                    code: ERROR_CODES.AUDIT_WRITE_FAILED,
                    action: input.action,
                    target_kind: input.target.kind,
                    target_id: input.target.id?.toString() ?? null,
                    actor_id: ctx.actor_id?.toString() ?? null,
                },
                'Audit log write failed'
            );
        } catch {
            // Nothing we can do at this point — swallow.
        }
    }
};

/**
 * Convenience wrapper for "system" events (cron jobs, future scheduled
 * runners). Sets `actor_id = null`, `actor_role = 'system'`, drops the
 * IP/UA fields entirely.
 */
export const recordSystemAudit = (input: RecordAuditInput & { request_id?: string | null }): Promise<void> => {
    const { request_id, ...rest } = input;
    return recordAudit(
        {
            actor_id: null,
            actor_role: 'system',
            request_id: request_id ?? null,
        },
        rest
    );
};

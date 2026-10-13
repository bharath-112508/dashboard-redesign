import { Types } from 'mongoose';

import { User, type UserDocument } from '../models/user.model.js';
import { AttendanceRecord } from '../models/attendance-record.model.js';
import { AttendanceCorrectionRequest } from '../models/attendance-correction-request.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveBalance } from '../models/leave-balance.model.js';
import { CompOffLedger } from '../models/comp-off-ledger.model.js';
import { Notification } from '../models/notification.model.js';
import { TaskComment } from '../models/task-comment.model.js';
import { TaskActivity } from '../models/task-activity.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { AuditLog } from '../models/audit-log.model.js';
import { RefreshToken } from '../models/refresh-token.model.js';
import { PasswordResetToken } from '../models/password-reset-token.model.js';
import { ReportPreset } from '../models/report-preset.model.js';
import { ReportSubscription } from '../models/report-subscription.model.js';
import { ReportExport } from '../models/report-export.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { deleteBlob, isAzureConfigured } from '../utils/azure-blob.js';
import { AZURE_BLOB_PROFILE_PHOTOS_CONTAINER } from '../config/server.config.js';
import logger from '../utils/logger.js';

/**
 * GDPR DSAR + right-to-erasure service (BACKEND_AUDIT.md P1-8).
 *
 * Two operations:
 *
 *  1. **Export** (`exportUserData`) — collect every row in the platform
 *     where `user_id`, `actor_id`, `created_by`, `assignee_id`, etc.
 *     equals the target. Returns one JSON blob the admin can hand to
 *     the user (or attach to a DSAR ticket). Read-only; no DB
 *     mutation; safe to run during business hours.
 *
 *  2. **Erasure** (`eraseUserData`) — anonymise the user's PII fields
 *     (email, full_name, phone, emergency contact, profile photo) on
 *     the user document while preserving the `_id` so all foreign
 *     keys keep referential integrity. Audit rows + leave rows + task
 *     rows DON'T have their `user_id` nulled — they need it for the
 *     business record — but the anonymised user document is what any
 *     join lands on, so the human identity is gone.
 *
 *     Also revokes every active session, deletes pending password-
 *     reset tokens, and emits an audit row stamped with the operation
 *     so the trail of "who erased whom and when" is permanent.
 *
 * Design decisions captured here so future contributors don't try to
 * "delete more aggressively":
 *  - We do NOT hard-delete audit rows. GDPR allows retention for legal
 *    compliance, and audit rows are the basis for every forensic
 *    investigation. Anonymising the user document is enough.
 *  - We do NOT hard-delete tasks / leave rows / comments. Those are
 *    business records and may be referenced by other users (e.g. a
 *    task assigned to me, where the original requester was the
 *    erased user). Anonymising the user is the contract.
 *  - We DO delete refresh tokens + reset tokens. Those exist purely
 *    to authenticate the user; once the user is gone, the tokens are
 *    dangerous lingering credentials.
 *  - We DO delete the profile-photo Blob via the existing service if
 *    set. The image is unique to the user and not a business record.
 *
 * Authorization: both operations are admin-only via the
 * `USER_DATA_EXPORT` / `USER_DATA_ERASURE` permissions on the route.
 * Self-export is intentionally NOT enabled here — all DSAR flows go
 * through an admin who reviews the request, the same as a paper
 * record-request workflow.
 */

// ─── Export ────────────────────────────────────────────────────────────

export interface UserDataExport {
    exported_at: string;
    user: Record<string, unknown> | null;
    refresh_tokens_active_count: number;
    attendance_records: Record<string, unknown>[];
    attendance_correction_requests: Record<string, unknown>[];
    leave_requests: Record<string, unknown>[];
    leave_balances: Record<string, unknown>[];
    comp_off_ledger: Record<string, unknown>[];
    notifications: Record<string, unknown>[];
    task_comments: Record<string, unknown>[];
    task_activities: Record<string, unknown>[];
    timesheet_entries: Record<string, unknown>[];
    audit_log_actor: Record<string, unknown>[];
    audit_log_target: Record<string, unknown>[];
    report_presets: Record<string, unknown>[];
    report_subscriptions: Record<string, unknown>[];
    report_exports: Record<string, unknown>[];
}

const stripDocFields = (rows: unknown[]): Record<string, unknown>[] =>
    (rows as Record<string, unknown>[]).map((row) => {
        const { __v, ...rest } = row;
        // `__v` is a Mongoose internal version key — never useful in an export.
        void __v;
        return rest;
    });

export const exportUserData = async (userId: Types.ObjectId): Promise<UserDataExport> => {
    const user = await User.findById(userId).lean<Record<string, unknown> | null>();
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }

    // Strip the password hash + MFA secret from the export. They're
    // not the user's data in the GDPR sense (they're hashed creds),
    // and an export with a bcrypt hash in it is a credential leak
    // vector if the export blob is ever mishandled downstream.
    const safeUser = { ...user };
    delete safeUser.password_hash;
    delete safeUser.mfa_secret_encrypted;
    delete safeUser.mfa_backup_codes_hashed;

    const [
        refreshActive,
        attendanceRecords,
        attendanceCorrections,
        leaveRequests,
        leaveBalances,
        compOffRows,
        notifications,
        taskComments,
        taskActivities,
        timesheetEntries,
        auditAsActor,
        auditAsTarget,
        reportPresets,
        reportSubs,
        reportExports,
    ] = await Promise.all([
        RefreshToken.countDocuments({ user_id: userId, revoked_at: null, expires_at: { $gt: new Date() } }),
        AttendanceRecord.find({ user_id: userId }).lean(),
        AttendanceCorrectionRequest.find({ user_id: userId }).lean(),
        LeaveRequest.find({ user_id: userId }).lean(),
        LeaveBalance.find({ user_id: userId }).lean(),
        CompOffLedger.find({ user_id: userId }).lean(),
        Notification.find({ user_id: userId }).lean(),
        TaskComment.find({ author_id: userId }).lean(),
        TaskActivity.find({ actor_id: userId }).lean(),
        TimesheetEntry.find({ user_id: userId }).lean(),
        AuditLog.find({ actor_id: userId }).lean(),
        AuditLog.find({ 'target_entity.kind': 'user', 'target_entity.id': userId }).lean(),
        ReportPreset.find({ created_by: userId }).lean(),
        ReportSubscription.find({ created_by: userId }).lean(),
        ReportExport.find({ requested_by: userId }).lean(),
    ]);

    return {
        exported_at: new Date().toISOString(),
        user: safeUser,
        refresh_tokens_active_count: refreshActive,
        attendance_records: stripDocFields(attendanceRecords),
        attendance_correction_requests: stripDocFields(attendanceCorrections),
        leave_requests: stripDocFields(leaveRequests),
        leave_balances: stripDocFields(leaveBalances),
        comp_off_ledger: stripDocFields(compOffRows),
        notifications: stripDocFields(notifications),
        task_comments: stripDocFields(taskComments),
        task_activities: stripDocFields(taskActivities),
        timesheet_entries: stripDocFields(timesheetEntries),
        audit_log_actor: stripDocFields(auditAsActor),
        audit_log_target: stripDocFields(auditAsTarget),
        report_presets: stripDocFields(reportPresets),
        report_subscriptions: stripDocFields(reportSubs),
        report_exports: stripDocFields(reportExports),
    };
};

// ─── Streaming export (M43) ────────────────────────────────────────────

/**
 * M43 — stream the GDPR export as newline-delimited JSON instead of
 * collecting everything into one in-memory object.
 *
 * Pre-M43 `exportUserData` ran 12 unbounded `.find().lean()` queries
 * in parallel and returned the whole tree as a single JS object. For a
 * 3-year-tenured user that's ~50k audit rows × ~1KB each = ~50 MB
 * resident before serialisation; a single concurrent export can pin a
 * worker for seconds and OOM on a 256-MB heap.
 *
 * Streaming flow: write one envelope-line per row via a cursor per
 * collection. The output is JSONL (`application/x-ndjson`) with each
 * line shaped as:
 *
 *     { "kind": "<collection>", "data": { … } }
 *
 * Bracketed by `{kind:'meta'}` and `{kind:'meta_end', row_counts: {…}}`
 * so a consumer can verify completeness. Memory bounded by the
 * cursor's batch size (Mongoose default 1000) × the size of a single
 * row.
 *
 * `exportUserData` (the JSON-tree variant) is kept as-is for the
 * existing unit tests + any in-process caller; only the HTTP
 * controller switches over.
 */

interface NdjsonWritable {
    write: (chunk: string) => boolean | unknown;
}

const writeJsonLine = (stream: NdjsonWritable, payload: Record<string, unknown>): void => {
    stream.write(JSON.stringify(payload) + '\n');
};

type LeanRow = Record<string, unknown>;
const stripRow = (row: LeanRow): LeanRow => {
    const { __v, ...rest } = row;
    void __v;
    return rest;
};

interface CollectionSpec {
    kind: string;
    cursor: () => AsyncIterable<unknown>;
}

export const exportUserDataNdjson = async (
    userId: Types.ObjectId,
    stream: NdjsonWritable
): Promise<{ row_counts: Record<string, number> }> => {
    const user = await User.findById(userId).lean<Record<string, unknown> | null>();
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }

    const safeUser = { ...user };
    delete safeUser.password_hash;
    delete safeUser.mfa_secret_encrypted;
    delete safeUser.mfa_backup_codes_hashed;

    const refreshActive = await RefreshToken.countDocuments({
        user_id: userId,
        revoked_at: null,
        expires_at: { $gt: new Date() },
    });

    writeJsonLine(stream, {
        kind: 'meta',
        exported_at: new Date().toISOString(),
        user_id: userId.toString(),
        refresh_tokens_active_count: refreshActive,
    });
    writeJsonLine(stream, { kind: 'user', data: safeUser });

    // Each spec produces an async-iterable cursor; we walk it inline and
    // write one JSONL line per row. Mongoose `.cursor()` defaults to a
    // 1k batch size — the memory profile is one batch × row size at
    // any moment, regardless of total row count.
    const collections: CollectionSpec[] = [
        { kind: 'attendance_record', cursor: () => AttendanceRecord.find({ user_id: userId }).lean().cursor() },
        {
            kind: 'attendance_correction_request',
            cursor: () => AttendanceCorrectionRequest.find({ user_id: userId }).lean().cursor(),
        },
        { kind: 'leave_request', cursor: () => LeaveRequest.find({ user_id: userId }).lean().cursor() },
        { kind: 'leave_balance', cursor: () => LeaveBalance.find({ user_id: userId }).lean().cursor() },
        { kind: 'comp_off_ledger', cursor: () => CompOffLedger.find({ user_id: userId }).lean().cursor() },
        { kind: 'notification', cursor: () => Notification.find({ user_id: userId }).lean().cursor() },
        { kind: 'task_comment', cursor: () => TaskComment.find({ author_id: userId }).lean().cursor() },
        { kind: 'task_activity', cursor: () => TaskActivity.find({ actor_id: userId }).lean().cursor() },
        { kind: 'timesheet_entry', cursor: () => TimesheetEntry.find({ user_id: userId }).lean().cursor() },
        { kind: 'audit_log_actor', cursor: () => AuditLog.find({ actor_id: userId }).lean().cursor() },
        {
            kind: 'audit_log_target',
            cursor: () => AuditLog.find({ 'target_entity.kind': 'user', 'target_entity.id': userId }).lean().cursor(),
        },
        { kind: 'report_preset', cursor: () => ReportPreset.find({ created_by: userId }).lean().cursor() },
        { kind: 'report_subscription', cursor: () => ReportSubscription.find({ created_by: userId }).lean().cursor() },
        { kind: 'report_export', cursor: () => ReportExport.find({ requested_by: userId }).lean().cursor() },
    ];

    const row_counts: Record<string, number> = {};
    for (const spec of collections) {
        let count = 0;
        for await (const row of spec.cursor()) {
            count += 1;
            writeJsonLine(stream, { kind: spec.kind, data: stripRow(row as LeanRow) });
        }
        row_counts[spec.kind] = count;
    }

    writeJsonLine(stream, { kind: 'meta_end', row_counts });
    return { row_counts };
};

// ─── Erasure ───────────────────────────────────────────────────────────

export interface EraseResult {
    user_id: string;
    anonymised_at: string;
    sessions_revoked: number;
    reset_tokens_deleted: number;
    /** True when an existing profile-photo blob was deleted from Azure. False if no photo was set, Azure isn't configured, or the delete failed (warn logged). */
    profile_photo_blob_deleted: boolean;
}

/**
 * Build the anonymised replacement payload. Stable suffix derived
 * from the `_id` so a re-run of the operation produces the same
 * shape (idempotent — and the suffix isn't a sequential counter that
 * would leak how many users have been erased over time).
 */
const buildAnonPayload = (user: UserDocument): Record<string, unknown> => {
    const stamp = user._id.toString().slice(-8);
    return {
        full_name: `Deleted user ${stamp}`,
        // Email is unique-indexed; we MUST keep it unique. `null` would
        // collide on a second deletion (multiple null emails). Use a
        // synthetic per-user value.
        email: `deleted-${stamp}@anonymised.invalid`,
        phone: null,
        slack_user_id: null,
        slack_notifications_enabled: false,
        profile_photo_blob_key: null,
        // Internal profile contains the employee_id + emergency contact —
        // both PII. We blank them but keep the structure so existing
        // joins don't fail on a missing sub-doc.
        'internal_profile.employee_id': `DEL-${stamp}`,
        'internal_profile.emergency_contact': null,
        // `client_profile` carries no free-text PII any more: `company_name`
        // and `point_of_contact` are both gone (it holds only `company_id` +
        // `access_type`), so there is nothing here to scrub.
        // Lock the account out so the synthetic email can't be used
        // for a password-reset flow.
        password_hash: 'erased',
        mfa_enabled: false,
        mfa_secret_encrypted: null,
        mfa_backup_codes_hashed: [],
        deactivated_at: new Date(),
        // T7 — use the canonical `users.status` enum value rather
        // than the out-of-enum `'disabled'` string. The schema's
        // enum is `active | deactivated`; pre-T7 we wrote
        // `'disabled'` here, which `User.updateOne` accepted (Mongoose
        // skips validators on updateOne by default) but stored an
        // out-of-enum value silently — confusing to forensics and a
        // landmine for future code that switch-cases on the enum.
        status: USER_STATUSES.DEACTIVATED,
    };
};

export const eraseUserData = async (userId: Types.ObjectId, auditCtx: AuditContext): Promise<EraseResult> => {
    const user = await User.findById(userId);
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }

    const before = {
        email: user.email,
        full_name: user.full_name,
        phone: user.phone ?? null,
        status: user.status,
    };

    // Capture the photo blob key BEFORE the user doc is mutated — the
    // `$set` below nulls it out and we'd lose the reference.
    const previousPhotoBlobKey = user.profile_photo_blob_key;

    // 1. Revoke every active session.
    const revokeResult = await RefreshToken.updateMany(
        { user_id: userId, revoked_at: null },
        { $set: { revoked_at: new Date() } }
    );

    // 2. Delete password-reset tokens.
    const resetDelete = await PasswordResetToken.deleteMany({ user_id: userId });

    // 3. Anonymise the user document (and the sub-doc PII fields via
    //    dotted paths). Mongoose's `$set` with dotted paths handles
    //    sub-doc surgery without overwriting unrelated fields.
    const anon = buildAnonPayload(user);
    await User.updateOne({ _id: userId }, { $set: anon });

    // 4. Delete the profile-photo blob (R1). The `$set` above nulled
    //    the blob_key on the user doc; without this delete the actual
    //    image file would stay in Azure indefinitely. Best-effort —
    //    a Blob delete failure must not block the rest of the
    //    erasure (the user doc is already anonymised, so an admin
    //    re-running the operation is idempotent on the doc side and
    //    will retry the blob delete).
    let photoBlobDeleted = false;
    if (previousPhotoBlobKey && isAzureConfigured()) {
        try {
            await deleteBlob(AZURE_BLOB_PROFILE_PHOTOS_CONTAINER, previousPhotoBlobKey);
            photoBlobDeleted = true;
        } catch (err) {
            logger.warn(
                { err, code: 'PROFILE_PHOTO_BLOB_DELETE_FAILED', user_id: userId.toString() },
                'GDPR erasure: profile-photo blob delete failed — re-run erasure to retry'
            );
        }
    } else if (previousPhotoBlobKey && !isAzureConfigured()) {
        logger.warn(
            { code: 'STORAGE_NOT_CONFIGURED', user_id: userId.toString() },
            'GDPR erasure: profile-photo blob delete skipped — Azure not configured'
        );
    }

    // 5. Audit the operation. Snapshot of `before` makes the
    //    operation trivially reversible at audit-review time IF
    //    legal requires it.
    await recordAudit(auditCtx, {
        action: AUDIT_ACTIONS.USER_DATA_ERASE,
        target: { kind: AUDIT_TARGET_KINDS.USER, id: userId },
        before,
        after: {
            email: anon.email,
            full_name: anon.full_name,
            status: anon.status,
        },
        metadata: {
            sessions_revoked: revokeResult.modifiedCount ?? 0,
            reset_tokens_deleted: resetDelete.deletedCount ?? 0,
            profile_photo_blob_deleted: photoBlobDeleted,
        },
    });

    logger.info(
        {
            user_id: userId.toString(),
            sessions_revoked: revokeResult.modifiedCount ?? 0,
            reset_tokens_deleted: resetDelete.deletedCount ?? 0,
            profile_photo_blob_deleted: photoBlobDeleted,
        },
        'GDPR right-to-erasure executed for user'
    );

    return {
        user_id: userId.toString(),
        anonymised_at: new Date().toISOString(),
        sessions_revoked: revokeResult.modifiedCount ?? 0,
        reset_tokens_deleted: resetDelete.deletedCount ?? 0,
        profile_photo_blob_deleted: photoBlobDeleted,
    };
};

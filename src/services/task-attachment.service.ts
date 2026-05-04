import { Types } from 'mongoose';
import { ulid } from 'ulid';

import { TaskAttachment, type TaskAttachmentDocument } from '../models/task-attachment.model.js';
import { Task } from '../models/task.model.js';
import type { ProjectDocument } from '../models/project.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { TASK_ACTIVITY_TYPES } from '../constants/task-activity.js';
import {
    ATTACHMENT_SAS_TTL_DEFAULT_MINUTES,
    ATTACHMENT_SAS_TTL_MAX_MINUTES,
    ATTACHMENT_SAS_TTL_MIN_MINUTES,
} from '../constants/attachment.js';
import { recordAudit } from './audit.service.js';
import { recordActivity } from './task-activity.service.js';
import { loadProjectForCaller } from './project.service.js';
import type { ProjectCaller } from './project.service.js';
import { getOrInitSettings } from './settings.service.js';
import {
    AzureNotConfiguredError,
    deleteBlob,
    headBlob,
    isAzureConfigured,
    mintDownloadSas,
    mintUploadSas,
} from '../utils/azure-blob.js';
import { AZURE_BLOB_TASK_ATTACHMENTS_CONTAINER } from '../config/server.config.js';
import logger from '../utils/logger.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    FinalizeAttachmentBody,
    ListAttachmentsQuery,
    UploadUrlBody,
} from '../validators/task-attachment.validator.js';

/**
 * Task-attachment service — Data_Model.md §5.6 / API_Contract.md §8.5 /
 * BUILD_PROGRESS.md Step 21.
 *
 * Architecture (mirrors `task-comment.service`):
 *  - Reads + writes are project-scoped through `loadProjectForCaller`.
 *  - Size + MIME policy is read from `system_settings.uploads` so an
 *    admin can change the rules without a redeploy. The validator only
 *    covers shape; the runtime cap lives here.
 *  - Soft-delete: `deleted_at` keeps the row for the activity feed; the
 *    underlying blob is best-effort deleted from storage on the same
 *    call (Azure 404s are swallowed).
 *  - Audit + activity are best-effort (`recordAudit` / `recordActivity`
 *    never throw); a failure to log must not block the user-visible
 *    write that already succeeded.
 *
 * Upload flow (two-step, mirrors API_Contract §8.5):
 *  1. `mintUploadUrl` validates the payload against `system_settings`,
 *     synthesises a deterministic blob_key, and returns a write-only
 *     SAS URL with the content-type pinned. No DB row is created here —
 *     a client that abandons the upload doesn't leave dangling rows.
 *  2. `finalizeAttachment` HEAD-checks the blob actually exists, the
 *     uploaded content-length matches what the client claimed, then
 *     persists the metadata row. Re-finalizing the same blob_key
 *     returns 409 thanks to the unique index on the model.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────

const isManagerOrAdmin = (role: string): boolean => role === ROLES.ADMIN || role === ROLES.MANAGER;

const toPublic = (doc: TaskAttachmentDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const loadTaskAndProject = async (
    taskId: Types.ObjectId,
    caller: ProjectCaller
): Promise<{ task: { _id: Types.ObjectId; project_id: Types.ObjectId }; project: ProjectDocument }> => {
    const task = await Task.findById(taskId)
        .select('_id project_id')
        .lean<{ _id: Types.ObjectId; project_id: Types.ObjectId } | null>();
    if (!task) throw AppError.notFound('Task not found', ERROR_CODES.TASK_NOT_FOUND);
    const project = await loadProjectForCaller(task.project_id, caller);
    return { task, project };
};

const loadAttachmentForAccess = async (
    attachmentId: Types.ObjectId,
    caller: ProjectCaller
): Promise<{ attachment: TaskAttachmentDocument; project: ProjectDocument }> => {
    const attachment = await TaskAttachment.findById(attachmentId);
    if (!attachment || attachment.deleted_at !== null) {
        throw AppError.notFound('Attachment not found', ERROR_CODES.ATTACHMENT_NOT_FOUND);
    }
    const { project } = await loadTaskAndProject(attachment.task_id, caller);
    return { attachment, project };
};

interface UploadPolicy {
    maxBytes: number;
    allowedMimeTypes: ReadonlySet<string>;
    sasTtlMinutes: number;
}

/**
 * Resolve effective upload policy from `system_settings.uploads`. The TTL
 * is clamped to a sane range so a misconfigured admin can't mint
 * very-long-lived SAS tokens (which would defeat the point of using SAS).
 */
const loadUploadPolicy = async (): Promise<UploadPolicy> => {
    const settings = await getOrInitSettings();
    const uploads = settings.uploads;
    const maxBytes = Math.max(0, Math.floor(uploads.max_file_size_mb * 1024 * 1024));
    const sasTtlMinutes = Math.min(
        ATTACHMENT_SAS_TTL_MAX_MINUTES,
        Math.max(
            ATTACHMENT_SAS_TTL_MIN_MINUTES,
            Number.isFinite(uploads.sas_token_ttl_minutes)
                ? uploads.sas_token_ttl_minutes
                : ATTACHMENT_SAS_TTL_DEFAULT_MINUTES
        )
    );
    return {
        maxBytes,
        allowedMimeTypes: new Set(uploads.allowed_mime_types ?? []),
        sasTtlMinutes,
    };
};

const assertAzureConfigured = (): void => {
    if (!isAzureConfigured()) {
        throw new AppError({
            statusCode: 503,
            code: ERROR_CODES.STORAGE_NOT_CONFIGURED,
            message: 'Attachment storage is not configured on this environment',
        });
    }
};

/**
 * Re-throw an Azure-side failure as a typed `AppError`. Always throws —
 * the `never` return tells TypeScript that any code after the call is
 * unreachable, so callers don't need a `return` keyword to convince the
 * compiler the variable in scope was definitely assigned.
 */
const mapAzureNotConfigured = (err: unknown): never => {
    if (err instanceof AzureNotConfiguredError) {
        throw new AppError({
            statusCode: 503,
            code: ERROR_CODES.STORAGE_NOT_CONFIGURED,
            message: err.message,
        });
    }
    throw err;
};

/**
 * Build a blob_key namespaced by **task + uploader**. Format:
 *   `tasks/{task_id}/users/{uploader_id}/{ulid}-{safe_filename}`
 *
 * Why the uploader segment matters (security):
 *  - The upload SAS is minted before any DB row exists, so for the
 *    window between mint and finalize there is nothing tying the blob
 *    to a specific user. Without the uploader segment, any project
 *    member who learns somebody else's blob_key (network logs, a
 *    leaked subscription event, an opportunistic guess) could call
 *    `/finalize` first and become the recorded uploader of someone
 *    else's file. Embedding the uploader_id in the path lets `/finalize`
 *    refuse blob_keys whose path doesn't match the caller — no extra
 *    DB state needed.
 *
 * The ULID guarantees uniqueness for the same filename re-uploaded twice
 * (collision risk is effectively zero) and provides natural ordering by
 * upload time. The filename is sanitised to ASCII alphanumerics + `.-_`
 * so storage tooling that doesn't speak unicode-encoded URLs has no
 * surprises (the *display* name keeps the original verbatim).
 */
const sanitiseFileName = (name: string): string => {
    const trimmed = name.trim();
    // Replace anything outside [A-Za-z0-9._-] with `_`. Collapse runs.
    const cleaned = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_');
    // Strip leading/trailing dots so we don't end up with `.hidden` / `name.`.
    const noEdges = cleaned.replace(/^[._-]+/, '').replace(/[._-]+$/, '');
    return noEdges.length > 0 ? noEdges : 'file';
};

export const buildBlobKey = (taskId: Types.ObjectId, uploaderId: Types.ObjectId, fileName: string): string => {
    const safe = sanitiseFileName(fileName);
    return `tasks/${taskId.toString()}/users/${uploaderId.toString()}/${ulid()}-${safe}`;
};

/**
 * Path prefix the finalize endpoint expects on `blob_key`. A request
 * whose `blob_key` doesn't start with this prefix is either targeting a
 * different task (route-level mismatch) or a different uploader (the
 * "steal somebody else's pending upload" attack — see `buildBlobKey`).
 */
const expectedBlobKeyPrefix = (taskId: Types.ObjectId, uploaderId: Types.ObjectId): string =>
    `tasks/${taskId.toString()}/users/${uploaderId.toString()}/`;

const assertSizeAllowed = (size: number, policy: UploadPolicy): void => {
    if (size > policy.maxBytes) {
        throw AppError.unprocessable(
            `File exceeds the maximum size of ${policy.maxBytes} bytes`,
            ERROR_CODES.FILE_TOO_LARGE,
            { max_bytes: policy.maxBytes, received_bytes: size }
        );
    }
};

const assertMimeAllowed = (mime: string, policy: UploadPolicy): void => {
    if (policy.allowedMimeTypes.size === 0) return; // empty allowlist = "no restrictions"
    if (!policy.allowedMimeTypes.has(mime)) {
        throw AppError.unprocessable(
            `MIME type "${mime}" is not in the upload allowlist`,
            ERROR_CODES.FILE_TYPE_NOT_ALLOWED,
            { mime_type: mime }
        );
    }
};

// ─── POST /tasks/:task_id/attachments/upload-url ─────────────────────────

export interface MintUploadUrlResult {
    upload_url: string;
    blob_container: string;
    blob_key: string;
    expires_at: Date;
    method: 'PUT';
    /**
     * The FE must send this exact `Content-Type` on the PUT — we pin it
     * into the SAS so a `.png` upload can't be served back as
     * `text/html`. Returning it explicitly removes guesswork.
     */
    required_headers: { 'x-ms-blob-type': 'BlockBlob'; 'Content-Type': string };
}

export const mintUploadUrl = async (
    taskId: Types.ObjectId,
    input: UploadUrlBody,
    caller: ProjectCaller
): Promise<MintUploadUrlResult> => {
    assertAzureConfigured();
    await loadTaskAndProject(taskId, caller); // throws if visibility fails

    const policy = await loadUploadPolicy();
    assertSizeAllowed(input.file_size, policy);
    assertMimeAllowed(input.mime_type, policy);

    const container = AZURE_BLOB_TASK_ATTACHMENTS_CONTAINER;
    const blobKey = buildBlobKey(taskId, caller.id, input.file_name);

    let minted: { url: string; expires_at: Date };
    try {
        minted = mintUploadSas({
            container,
            blobKey,
            ttlMinutes: policy.sasTtlMinutes,
            contentType: input.mime_type,
        });
    } catch (err) {
        throw mapAzureNotConfigured(err);
    }

    return {
        upload_url: minted.url,
        blob_container: container,
        blob_key: blobKey,
        expires_at: minted.expires_at,
        method: 'PUT',
        required_headers: {
            'x-ms-blob-type': 'BlockBlob',
            'Content-Type': input.mime_type,
        },
    };
};

// ─── POST /tasks/:task_id/attachments/finalize ───────────────────────────

export const finalizeAttachment = async (
    taskId: Types.ObjectId,
    input: FinalizeAttachmentBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    assertAzureConfigured();
    const { task, project } = await loadTaskAndProject(taskId, caller);

    // Re-validate against the *current* policy: the FE may have minted
    // an upload URL when the cap was 25 MiB and the admin has since
    // tightened it to 10 MiB.
    const policy = await loadUploadPolicy();
    assertSizeAllowed(input.file_size, policy);
    assertMimeAllowed(input.mime_type, policy);

    // The blob_key must be namespaced under both the task AND the caller
    // (uploader). The task segment defends against finalizing a key minted
    // for some other task; the uploader segment defends against the "race
    // to finalize someone else's pending upload" attack — see
    // `buildBlobKey` for the full reasoning.
    const expectedPrefix = expectedBlobKeyPrefix(task._id, caller.id);
    if (!input.blob_key.startsWith(expectedPrefix) || input.blob_container !== AZURE_BLOB_TASK_ATTACHMENTS_CONTAINER) {
        throw AppError.unprocessable(
            'blob_key does not belong to this task / uploader / container',
            ERROR_CODES.ATTACHMENT_BLOB_KEY_MISMATCH,
            { expected_prefix: expectedPrefix, expected_container: AZURE_BLOB_TASK_ATTACHMENTS_CONTAINER }
        );
    }

    // Verify the blob is actually present + the size matches what the
    // client is claiming. This catches the "metadata-only spoof" where a
    // client never PUTs the file but calls finalize anyway, AND the
    // "claimed 1 MiB but uploaded 100 MiB" mismatch where someone tries
    // to bypass the size cap by lying on /upload-url.
    let head;
    try {
        head = await headBlob(input.blob_container, input.blob_key);
    } catch (err) {
        throw mapAzureNotConfigured(err);
    }
    if (!head.exists) {
        throw AppError.unprocessable(
            'No uploaded blob was found for this key — upload it before finalizing',
            ERROR_CODES.ATTACHMENT_BLOB_MISSING,
            { blob_key: input.blob_key }
        );
    }
    if (typeof head.size === 'number' && head.size !== input.file_size) {
        throw AppError.unprocessable(
            'Uploaded file size does not match the value supplied to finalize',
            ERROR_CODES.ATTACHMENT_SIZE_MISMATCH,
            { claimed_bytes: input.file_size, actual_bytes: head.size }
        );
    }
    // Re-check size against policy using the *actual* byte count from
    // Azure, not what the client claimed.
    if (typeof head.size === 'number') assertSizeAllowed(head.size, policy);

    let created: TaskAttachmentDocument;
    try {
        created = await TaskAttachment.create({
            task_id: task._id,
            uploaded_by: caller.id,
            file_name: input.file_name,
            file_size: typeof head.size === 'number' ? head.size : input.file_size,
            mime_type: input.mime_type,
            blob_container: input.blob_container,
            blob_key: input.blob_key,
            deleted_at: null,
        });
    } catch (err: unknown) {
        // Unique index on `blob_key` — re-finalize for the same key (e.g.
        // a retry of a successful call) returns a clean 409 rather than
        // 500.
        const e = err as { code?: number; keyPattern?: Record<string, unknown> };
        if (e?.code === 11000 && e.keyPattern?.blob_key) {
            throw AppError.conflict('An attachment with this blob_key already exists', ERROR_CODES.DUPLICATE_RESOURCE, {
                blob_key: input.blob_key,
            });
        }
        throw err;
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.ATTACHMENT_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.ATTACHMENT, id: created._id },
            after: toPublic(created),
            metadata: {
                task_id: task._id.toString(),
                project_id: project._id.toString(),
                size_bytes: created.file_size,
                mime_type: created.mime_type,
            },
        });
    }

    await recordActivity({
        task_id: task._id,
        actor_id: caller.id,
        activity_type: TASK_ACTIVITY_TYPES.ATTACHMENT_ADDED,
        to_value: created._id,
        metadata: {
            attachment_id: created._id.toString(),
            file_name: created.file_name,
            size_bytes: created.file_size,
            mime_type: created.mime_type,
        },
    });

    return toPublic(created);
};

// ─── GET /tasks/:task_id/attachments ─────────────────────────────────────

export const listAttachments = async (
    taskId: Types.ObjectId,
    query: ListAttachmentsQuery,
    caller: ProjectCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    await loadTaskAndProject(taskId, caller);

    const filter: Record<string, unknown> = { task_id: taskId };
    if (!(query.include_deleted && isManagerOrAdmin(caller.role))) {
        filter.deleted_at = null;
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        TaskAttachment.find(filter).sort({ created_at: 1, _id: 1 }).skip(skip).limit(query.limit),
        TaskAttachment.countDocuments(filter),
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

// ─── GET /attachments/:id/download-url ───────────────────────────────────

export interface MintDownloadUrlResult {
    download_url: string;
    expires_at: Date;
    file_name: string;
    mime_type: string;
    size_bytes: number;
}

export const mintDownloadUrl = async (
    attachmentId: Types.ObjectId,
    caller: ProjectCaller
): Promise<MintDownloadUrlResult> => {
    assertAzureConfigured();
    const { attachment } = await loadAttachmentForAccess(attachmentId, caller);

    const policy = await loadUploadPolicy();
    let minted: { url: string; expires_at: Date };
    try {
        minted = mintDownloadSas({
            container: attachment.blob_container,
            blobKey: attachment.blob_key,
            ttlMinutes: policy.sasTtlMinutes,
            fileName: attachment.file_name,
        });
    } catch (err) {
        throw mapAzureNotConfigured(err);
    }

    return {
        download_url: minted.url,
        expires_at: minted.expires_at,
        file_name: attachment.file_name,
        mime_type: attachment.mime_type,
        size_bytes: attachment.file_size,
    };
};

// ─── DELETE /attachments/:id ─────────────────────────────────────────────
//
// Uploader OR admin/manager — same moderator pattern as comments.
// Soft-deletes the row (`deleted_at`) and best-effort deletes the blob.

export const deleteAttachment = async (
    attachmentId: Types.ObjectId,
    caller: ProjectCaller
): Promise<{ deleted: true }> => {
    const { attachment, project } = await loadAttachmentForAccess(attachmentId, caller);

    const isUploader = attachment.uploaded_by.equals(caller.id);
    if (!isUploader && !isManagerOrAdmin(caller.role)) {
        throw AppError.forbidden(
            'Only the uploader or an admin/manager can delete this attachment',
            ERROR_CODES.ATTACHMENT_DELETE_FORBIDDEN
        );
    }

    const before = toPublic(attachment);
    attachment.deleted_at = new Date();
    await attachment.save();

    // Best-effort blob delete — `deleteBlob` swallows its own errors and
    // logs them with `BLOB_DELETE_FAILED`. The row is already soft-
    // deleted by the time we get here, so a transient Azure failure
    // shouldn't flip the user's success signal.
    if (isAzureConfigured()) {
        await deleteBlob(attachment.blob_container, attachment.blob_key);
    } else {
        logger.warn(
            { code: 'STORAGE_NOT_CONFIGURED', attachment_id: attachment._id.toString() },
            'Attachment soft-deleted but blob delete skipped — Azure not configured'
        );
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.ATTACHMENT_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.ATTACHMENT, id: attachment._id },
            before,
            metadata: {
                task_id: attachment.task_id.toString(),
                project_id: project._id.toString(),
                deleted_by: isUploader ? 'uploader' : 'moderator',
            },
        });
    }

    await recordActivity({
        task_id: attachment.task_id,
        actor_id: caller.id,
        activity_type: TASK_ACTIVITY_TYPES.ATTACHMENT_REMOVED,
        from_value: attachment._id,
        metadata: {
            attachment_id: attachment._id.toString(),
            file_name: attachment.file_name,
            deleted_by: isUploader ? 'uploader' : 'moderator',
        },
    });

    return { deleted: true };
};

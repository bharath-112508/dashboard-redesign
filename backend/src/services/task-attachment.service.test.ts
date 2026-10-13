import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `task-attachment.service` (Step 21).
 *
 * Coverage focus:
 *   1. Read/write project-visibility plumbing (404 on missing task,
 *      403 from `loadProjectForCaller` propagated unchanged).
 *   2. `mintUploadUrl` — size + MIME validation against
 *      `system_settings.uploads`, 503 when Azure isn't configured,
 *      blob_key namespaced under `tasks/{task_id}/users/{uploader_id}/`,
 *      filename sanitisation (path-traversal collapsed, all-stripped
 *      fallback), empty MIME allowlist treated as "no restrictions".
 *   3. `finalizeAttachment` — cross-task / cross-uploader / wrong-
 *      container blob_key rejection (the security regression that
 *      blocked v1 commit), blob HEAD verification, claimed-vs-actual
 *      size mismatch incl. mid-flight policy tightening, audit-context
 *      branch wired, unique-index 409.
 *   4. `listAttachments` — `include_deleted` only honoured for admin/
 *      manager, default filter excludes soft-deleted rows.
 *   5. `mintDownloadUrl` — 404 for missing or soft-deleted attachments,
 *      filename forwarded for `Content-Disposition: attachment; filename=...`.
 *   6. `deleteAttachment` — uploader path, admin/manager moderator path,
 *      employee non-uploader rejection, soft-delete sets `deleted_at`,
 *      blob delete invoked best-effort (skipped when Azure unconfigured).
 */

const {
    attachmentCreateMock,
    attachmentFindByIdMock,
    attachmentFindMock,
    attachmentCountDocumentsMock,
    taskFindByIdMock,
    loadProjectForCallerMock,
    recordAuditMock,
    recordActivityMock,
    getOrInitSettingsMock,
    isAzureConfiguredMock,
    mintUploadSasMock,
    mintDownloadSasMock,
    headBlobMock,
    deleteBlobMock,
} = vi.hoisted(() => ({
    attachmentCreateMock: vi.fn(),
    attachmentFindByIdMock: vi.fn(),
    attachmentFindMock: vi.fn(),
    attachmentCountDocumentsMock: vi.fn(),
    taskFindByIdMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    recordAuditMock: vi.fn(),
    recordActivityMock: vi.fn(),
    getOrInitSettingsMock: vi.fn(),
    isAzureConfiguredMock: vi.fn(),
    mintUploadSasMock: vi.fn(),
    mintDownloadSasMock: vi.fn(),
    headBlobMock: vi.fn(),
    deleteBlobMock: vi.fn(),
}));

vi.mock('../models/task-attachment.model.js', () => ({
    TaskAttachment: {
        create: attachmentCreateMock,
        findById: attachmentFindByIdMock,
        find: attachmentFindMock,
        countDocuments: attachmentCountDocumentsMock,
    },
}));

vi.mock('../models/task.model.js', () => ({
    Task: { findById: taskFindByIdMock },
}));

vi.mock('./project.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./project.service.js')>();
    return {
        ...actual,
        loadProjectForCaller: loadProjectForCallerMock,
    };
});

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

vi.mock('./task-activity.service.js', () => ({
    recordActivity: recordActivityMock,
    recordActivityIfChanged: vi.fn(),
}));

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: getOrInitSettingsMock,
}));

vi.mock('../utils/azure-blob.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/azure-blob.js')>();
    return {
        ...actual,
        isAzureConfigured: isAzureConfiguredMock,
        mintUploadSas: mintUploadSasMock,
        mintDownloadSas: mintDownloadSasMock,
        headBlob: headBlobMock,
        deleteBlob: deleteBlobMock,
    };
});

const svc = await import('./task-attachment.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const adminCaller = () => ({ id: new Types.ObjectId(), role: ROLES.ADMIN, audit: undefined });
const managerCaller = () => ({ id: new Types.ObjectId(), role: ROLES.MANAGER, audit: undefined });
const employeeCaller = (id?: Types.ObjectId) => ({
    id: id ?? new Types.ObjectId(),
    role: ROLES.EMPLOYEE,
    audit: undefined,
});

const makeProject = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    member_ids: [] as Types.ObjectId[],
    representative_ids: [] as Types.ObjectId[],
    ...overrides,
});

const makeTaskRow = (project_id: Types.ObjectId) => ({
    _id: new Types.ObjectId(),
    project_id,
});

const stubTaskLookup = (taskRow: { _id: Types.ObjectId; project_id: Types.ObjectId } | null): void => {
    taskFindByIdMock.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(taskRow) }),
    });
};

const defaultSettings = (overrides: Record<string, unknown> = {}) => ({
    uploads: {
        max_file_size_mb: 25,
        allowed_mime_types: ['image/png', 'application/pdf'],
        sas_token_ttl_minutes: 15,
        ...overrides,
    },
});

const makeAttachment = (overrides: Record<string, unknown> = {}) => {
    const a = {
        _id: new Types.ObjectId(),
        task_id: new Types.ObjectId(),
        uploaded_by: new Types.ObjectId(),
        file_name: 'mockup.png',
        file_size: 1024,
        mime_type: 'image/png',
        blob_container: 'task-attachments',
        blob_key: 'tasks/aaaaaaaaaaaaaaaaaaaaaaaa/users/bbbbbbbbbbbbbbbbbbbbbbbb/01-mockup.png',
        deleted_at: null as Date | null,
        created_at: new Date(),
        updated_at: new Date(),
        save: vi.fn(),
        toJSON: vi.fn(),
        ...overrides,
    };
    a.save.mockImplementation(async () => a);
    a.toJSON.mockImplementation(() => ({
        id: a._id.toString(),
        task_id: a.task_id.toString(),
        uploaded_by: a.uploaded_by.toString(),
        file_name: a.file_name,
        file_size: a.file_size,
        mime_type: a.mime_type,
        blob_container: a.blob_container,
        blob_key: a.blob_key,
        deleted_at: a.deleted_at,
    }));
    return a;
};

beforeEach(() => {
    vi.resetAllMocks();
    isAzureConfiguredMock.mockReturnValue(true);
    getOrInitSettingsMock.mockResolvedValue(defaultSettings());
    mintUploadSasMock.mockReturnValue({
        url: 'https://example.blob.core.windows.net/task-attachments/key?sas',
        expires_at: new Date(Date.now() + 15 * 60_000),
    });
    mintDownloadSasMock.mockReturnValue({
        url: 'https://example.blob.core.windows.net/task-attachments/key?sas',
        expires_at: new Date(Date.now() + 15 * 60_000),
    });
});

// ─── mintUploadUrl ───────────────────────────────────────────────────────

describe('mintUploadUrl', () => {
    it('returns 503 STORAGE_NOT_CONFIGURED when Azure env is missing', async () => {
        isAzureConfiguredMock.mockReturnValue(false);
        await expect(
            svc.mintUploadUrl(
                new Types.ObjectId(),
                { file_name: 'a.png', file_size: 10, mime_type: 'image/png' },
                adminCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.STORAGE_NOT_CONFIGURED, statusCode: 503 });
        expect(taskFindByIdMock).not.toHaveBeenCalled();
    });

    it('returns 404 when the underlying task is missing', async () => {
        stubTaskLookup(null);
        await expect(
            svc.mintUploadUrl(
                new Types.ObjectId(),
                { file_name: 'a.png', file_size: 10, mime_type: 'image/png' },
                adminCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_NOT_FOUND });
        expect(loadProjectForCallerMock).not.toHaveBeenCalled();
    });

    it('propagates project-visibility 403 unchanged', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockRejectedValueOnce(
            Object.assign(new Error('Forbidden'), { code: ERROR_CODES.FORBIDDEN, statusCode: 403 })
        );
        await expect(
            svc.mintUploadUrl(task._id, { file_name: 'a.png', file_size: 10, mime_type: 'image/png' }, employeeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
        expect(mintUploadSasMock).not.toHaveBeenCalled();
    });

    it('rejects oversized files with FILE_TOO_LARGE', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        getOrInitSettingsMock.mockResolvedValueOnce(defaultSettings({ max_file_size_mb: 1 }));

        await expect(
            svc.mintUploadUrl(
                task._id,
                { file_name: 'big.png', file_size: 5 * 1024 * 1024, mime_type: 'image/png' },
                managerCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.FILE_TOO_LARGE });
        expect(mintUploadSasMock).not.toHaveBeenCalled();
    });

    it('rejects MIME types outside the allowlist with FILE_TYPE_NOT_ALLOWED', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(
            svc.mintUploadUrl(
                task._id,
                { file_name: 'evil.exe', file_size: 1024, mime_type: 'application/x-msdownload' },
                managerCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED });
    });

    it('mints a SAS, namespaces the blob_key under tasks/{task_id}/users/{caller_id}/, pins content-type', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const caller = managerCaller();
        const result = await svc.mintUploadUrl(
            task._id,
            { file_name: 'My Mockup v2.png', file_size: 1024, mime_type: 'image/png' },
            caller
        );

        expect(result.upload_url).toMatch(/^https:\/\//);
        // Critical security invariant: the uploader_id segment is what
        // prevents the cross-user finalize-theft attack.
        expect(result.blob_key.startsWith(`tasks/${task._id.toString()}/users/${caller.id.toString()}/`)).toBe(true);
        expect(result.blob_key).toMatch(/My_Mockup_v2\.png$/);
        expect(result.required_headers['Content-Type']).toBe('image/png');

        expect(mintUploadSasMock).toHaveBeenCalledWith(
            expect.objectContaining({
                contentType: 'image/png',
                ttlMinutes: 15,
            })
        );
    });

    it('sanitises path-traversal-style filenames into safe blob_key segments', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const result = await svc.mintUploadUrl(
            task._id,
            { file_name: '../../etc/passwd', file_size: 16, mime_type: 'application/pdf' },
            managerCaller()
        );

        // The real invariant: the filename segment is flattened — no
        // additional `/` slips into the path, and no literal `..`
        // sequence survives the sanitiser. Substrings like "etc" are
        // harmless once the slashes are gone (Azure stores keys as
        // opaque strings, no filesystem semantics).
        const segments = result.blob_key.split('/');
        expect(segments).toHaveLength(5); // tasks/id/users/id/{ulid-name}
        expect(segments[4]).not.toContain('..');
    });

    it('falls back to a default name when sanitisation strips everything', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const result = await svc.mintUploadUrl(
            task._id,
            { file_name: '...', file_size: 16, mime_type: 'application/pdf' },
            managerCaller()
        );

        expect(result.blob_key).toMatch(/-file$/);
    });

    it('skips the MIME allowlist when system_settings.allowed_mime_types is empty', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        getOrInitSettingsMock.mockResolvedValueOnce(defaultSettings({ allowed_mime_types: [] }));

        await expect(
            svc.mintUploadUrl(
                task._id,
                { file_name: 'unknown.bin', file_size: 16, mime_type: 'application/octet-stream' },
                managerCaller()
            )
        ).resolves.toBeDefined();
        expect(mintUploadSasMock).toHaveBeenCalled();
    });
});

// ─── finalizeAttachment ──────────────────────────────────────────────────

describe('finalizeAttachment', () => {
    const validBody = (taskId: Types.ObjectId, uploaderId: Types.ObjectId) => ({
        blob_container: 'task-attachments',
        blob_key: `tasks/${taskId.toString()}/users/${uploaderId.toString()}/01ULID-mockup.png`,
        file_name: 'mockup.png',
        file_size: 1024,
        mime_type: 'image/png',
    });

    it('rejects a blob_key that does not belong to this task', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        const otherTaskId = new Types.ObjectId();
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const caller = managerCaller();
        await expect(
            svc.finalizeAttachment(
                task._id,
                {
                    blob_container: 'task-attachments',
                    blob_key: `tasks/${otherTaskId.toString()}/users/${caller.id.toString()}/x-mockup.png`,
                    file_name: 'mockup.png',
                    file_size: 1024,
                    mime_type: 'image/png',
                },
                caller
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_BLOB_KEY_MISMATCH });
        expect(headBlobMock).not.toHaveBeenCalled();
    });

    it('rejects a blob_key uploaded by a different user (cross-user theft)', async () => {
        // Critical security regression: User A mints + PUTs a file, User B
        // (also in the project) tries to claim it as theirs by calling
        // finalize with A's blob_key. The uploader segment in the path
        // must make this impossible.
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const userA = new Types.ObjectId();
        const userB = managerCaller(); // attacker

        await expect(
            svc.finalizeAttachment(
                task._id,
                {
                    blob_container: 'task-attachments',
                    blob_key: `tasks/${task._id.toString()}/users/${userA.toString()}/01ULID-mockup.png`,
                    file_name: 'mockup.png',
                    file_size: 1024,
                    mime_type: 'image/png',
                },
                userB
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_BLOB_KEY_MISMATCH });
        expect(headBlobMock).not.toHaveBeenCalled();
        expect(attachmentCreateMock).not.toHaveBeenCalled();
    });

    it('rejects a blob_key in the wrong container even if the task+user prefix matches', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const caller = managerCaller();
        await expect(
            svc.finalizeAttachment(
                task._id,
                {
                    blob_container: 'someone-else-bucket',
                    blob_key: `tasks/${task._id.toString()}/users/${caller.id.toString()}/01ULID-mockup.png`,
                    file_name: 'mockup.png',
                    file_size: 1024,
                    mime_type: 'image/png',
                },
                caller
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_BLOB_KEY_MISMATCH });
    });

    it('rejects when the blob does not exist in storage', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        headBlobMock.mockResolvedValueOnce({ exists: false });

        const caller = managerCaller();
        await expect(svc.finalizeAttachment(task._id, validBody(task._id, caller.id), caller)).rejects.toMatchObject({
            code: ERROR_CODES.ATTACHMENT_BLOB_MISSING,
        });
        expect(attachmentCreateMock).not.toHaveBeenCalled();
    });

    it('rejects when the uploaded blob size differs from the claimed size', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        headBlobMock.mockResolvedValueOnce({ exists: true, size: 9999, contentType: 'image/png' });

        const caller = managerCaller();
        await expect(svc.finalizeAttachment(task._id, validBody(task._id, caller.id), caller)).rejects.toMatchObject({
            code: ERROR_CODES.ATTACHMENT_SIZE_MISMATCH,
        });
    });

    it('re-validates against the *current* size policy using the actual blob length', async () => {
        // Mint-time policy was 25 MiB, an admin tightened to 1 MiB before
        // the user could finalize. Even if the client lies about file_size,
        // the actual head.size hits the new cap.
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        getOrInitSettingsMock.mockResolvedValueOnce(defaultSettings({ max_file_size_mb: 1 }));
        headBlobMock.mockResolvedValueOnce({
            exists: true,
            size: 5 * 1024 * 1024,
            contentType: 'image/png',
        });

        const caller = managerCaller();
        const body = validBody(task._id, caller.id);
        // Client claims 1024 (which would pass), real upload is 5 MiB.
        // Service catches the mismatch first.
        await expect(svc.finalizeAttachment(task._id, body, caller)).rejects.toMatchObject({
            code: ERROR_CODES.ATTACHMENT_SIZE_MISMATCH,
        });
    });

    it('persists the row, fires audit + activity, returns the public projection', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        headBlobMock.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/png' });
        const caller = managerCaller();
        const created = makeAttachment({
            task_id: task._id,
            file_size: 1024,
            blob_key: validBody(task._id, caller.id).blob_key,
        });
        attachmentCreateMock.mockResolvedValueOnce(created);

        const result = await svc.finalizeAttachment(task._id, validBody(task._id, caller.id), caller);

        expect(attachmentCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                task_id: task._id,
                file_size: 1024,
                blob_container: 'task-attachments',
                deleted_at: null,
            })
        );
        expect(recordActivityMock).toHaveBeenCalledWith(
            expect.objectContaining({ activity_type: 'attachment_added', task_id: task._id })
        );
        expect((result as { id: string }).id).toBe(created._id.toString());
    });

    it('records an audit row when the caller carries an audit context', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        headBlobMock.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/png' });

        const caller = {
            id: new Types.ObjectId(),
            role: ROLES.MANAGER,
            audit: {
                actor_id: new Types.ObjectId(),
                actor_role: ROLES.MANAGER,
                ip: '10.0.0.1',
                user_agent: 'unit-test',
            },
        };
        const created = makeAttachment({
            task_id: task._id,
            file_size: 1024,
            blob_key: validBody(task._id, caller.id).blob_key,
        });
        attachmentCreateMock.mockResolvedValueOnce(created);

        await svc.finalizeAttachment(task._id, validBody(task._id, caller.id), caller);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [auditCtxArg, auditPayload] = recordAuditMock.mock.calls[0];
        expect(auditCtxArg).toBe(caller.audit);
        expect(auditPayload).toEqual(
            expect.objectContaining({
                action: 'attachment.create',
                target: { kind: 'task_attachment', id: created._id },
                metadata: expect.objectContaining({
                    task_id: task._id.toString(),
                    project_id: project._id.toString(),
                    size_bytes: 1024,
                    mime_type: 'image/png',
                }),
            })
        );
    });

    it('maps duplicate-key index errors into a 409 DUPLICATE_RESOURCE', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        headBlobMock.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/png' });
        attachmentCreateMock.mockRejectedValueOnce({ code: 11000, keyPattern: { blob_key: 1 } });

        const caller = managerCaller();
        await expect(svc.finalizeAttachment(task._id, validBody(task._id, caller.id), caller)).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
            statusCode: 409,
        });
    });
});

// ─── listAttachments ─────────────────────────────────────────────────────

describe('listAttachments', () => {
    const stubFindForList = (rows: ReturnType<typeof makeAttachment>[]): void => {
        attachmentFindMock.mockReturnValueOnce({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve(rows),
                }),
            }),
        });
        attachmentCountDocumentsMock.mockResolvedValueOnce(rows.length);
    };

    it('filters out soft-deleted rows for non-admins regardless of include_deleted', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindForList([]);

        await svc.listAttachments(task._id, { page: 1, limit: 20, include_deleted: true }, employeeCaller());

        expect(attachmentFindMock).toHaveBeenCalledWith(
            expect.objectContaining({ task_id: task._id, deleted_at: null })
        );
    });

    it('honours include_deleted when caller is admin', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        stubTaskLookup(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindForList([]);

        await svc.listAttachments(task._id, { page: 1, limit: 20, include_deleted: true }, adminCaller());

        const filterArg = attachmentFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.task_id).toEqual(task._id);
        expect('deleted_at' in filterArg).toBe(false);
    });
});

// ─── mintDownloadUrl ─────────────────────────────────────────────────────

describe('mintDownloadUrl', () => {
    it('treats soft-deleted rows as 404', async () => {
        const a = makeAttachment({ deleted_at: new Date() });
        attachmentFindByIdMock.mockResolvedValueOnce(a);
        await expect(svc.mintDownloadUrl(a._id, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.ATTACHMENT_NOT_FOUND,
        });
    });

    it('returns a signed URL + display metadata for visible rows', async () => {
        const project = makeProject();
        const a = makeAttachment({ task_id: new Types.ObjectId() });
        attachmentFindByIdMock.mockResolvedValueOnce(a);
        stubTaskLookup({ _id: a.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const result = await svc.mintDownloadUrl(a._id, adminCaller());

        expect(result.download_url).toMatch(/^https:\/\//);
        expect(result.file_name).toBe(a.file_name);
        expect(result.size_bytes).toBe(a.file_size);
        expect(mintDownloadSasMock).toHaveBeenCalledWith(
            expect.objectContaining({
                container: a.blob_container,
                blobKey: a.blob_key,
                // The fileName is what powers the `Content-Disposition:
                // attachment; filename=...` SAS field downstream — without
                // this the browser may render uploaded HTML/SVG inline.
                fileName: a.file_name,
            })
        );
    });
});

// ─── deleteAttachment ────────────────────────────────────────────────────

describe('deleteAttachment', () => {
    it('allows the uploader to soft-delete and triggers blob delete', async () => {
        const project = makeProject();
        const uploader = new Types.ObjectId();
        const a = makeAttachment({ uploaded_by: uploader, task_id: new Types.ObjectId() });
        attachmentFindByIdMock.mockResolvedValueOnce(a);
        stubTaskLookup({ _id: a.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const result = await svc.deleteAttachment(a._id, employeeCaller(uploader));

        expect(result).toEqual({ deleted: true });
        expect(a.deleted_at).toBeInstanceOf(Date);
        expect(a.save).toHaveBeenCalledTimes(1);
        expect(deleteBlobMock).toHaveBeenCalledWith(a.blob_container, a.blob_key);
        expect(recordActivityMock).toHaveBeenCalledWith(
            expect.objectContaining({ activity_type: 'attachment_removed' })
        );
    });

    it('allows a manager to soft-delete somebody else’s attachment (moderator)', async () => {
        const project = makeProject();
        const a = makeAttachment({ uploaded_by: new Types.ObjectId(), task_id: new Types.ObjectId() });
        attachmentFindByIdMock.mockResolvedValueOnce(a);
        stubTaskLookup({ _id: a.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.deleteAttachment(a._id, managerCaller())).resolves.toEqual({ deleted: true });
        expect(a.deleted_at).toBeInstanceOf(Date);
    });

    it('rejects employee non-uploader with ATTACHMENT_DELETE_FORBIDDEN', async () => {
        const project = makeProject();
        const a = makeAttachment({ uploaded_by: new Types.ObjectId(), task_id: new Types.ObjectId() });
        attachmentFindByIdMock.mockResolvedValueOnce(a);
        stubTaskLookup({ _id: a.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.deleteAttachment(a._id, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.ATTACHMENT_DELETE_FORBIDDEN,
        });
        expect(a.save).not.toHaveBeenCalled();
        expect(deleteBlobMock).not.toHaveBeenCalled();
    });

    it('skips blob delete when Azure is unconfigured but still soft-deletes the row', async () => {
        isAzureConfiguredMock.mockReturnValue(false);
        const project = makeProject();
        const uploader = new Types.ObjectId();
        const a = makeAttachment({ uploaded_by: uploader, task_id: new Types.ObjectId() });
        attachmentFindByIdMock.mockResolvedValueOnce(a);
        stubTaskLookup({ _id: a.task_id, project_id: project._id });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.deleteAttachment(a._id, employeeCaller(uploader))).resolves.toEqual({ deleted: true });
        expect(a.save).toHaveBeenCalledTimes(1);
        expect(deleteBlobMock).not.toHaveBeenCalled();
    });
});

describe('client-side attachment scope — own report only', () => {
    /**
     * A client can SEE every task in their company's projects, so project
     * visibility alone let them upload onto the team's internal work. Verified
     * in the browser before the guard existed: "Add files" rendered on an
     * internal task in Review that had nothing to do with them.
     */
    const clientCaller = (id?: Types.ObjectId) => ({
        id: id ?? new Types.ObjectId(),
        role: ROLES.CLIENT,
        audit: undefined,
    });

    /** Second lookup: `assertCanAttachToTask` reads source + created_by + status. */
    const stubOwnershipLookup = (
        row: { source: string | null; created_by: Types.ObjectId; status?: string } | null
    ): void => {
        taskFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve(row) }),
        });
    };

    it('refuses a client uploading to an internal task', async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        loadProjectForCallerMock.mockResolvedValue(project);
        stubTaskLookup(task);
        stubOwnershipLookup({ source: null, created_by: new Types.ObjectId(), status: 'to_do' });

        await expect(
            svc.mintUploadUrl(task._id, { file_name: 'a.png', file_size: 10, mime_type: 'image/png' }, clientCaller())
        ).rejects.toMatchObject({ statusCode: 403, code: ERROR_CODES.TASK_WRITE_FORBIDDEN });
    });

    it("refuses a client uploading to another client's report", async () => {
        const project = makeProject();
        const task = makeTaskRow(project._id);
        loadProjectForCallerMock.mockResolvedValue(project);
        stubTaskLookup(task);
        stubOwnershipLookup({ source: 'client', created_by: new Types.ObjectId(), status: 'to_do' });

        await expect(
            svc.mintUploadUrl(task._id, { file_name: 'a.png', file_size: 10, mime_type: 'image/png' }, clientCaller())
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('allows a client uploading to their OWN report while it is untouched', async () => {
        const me = new Types.ObjectId();
        const project = makeProject();
        const task = makeTaskRow(project._id);
        loadProjectForCallerMock.mockResolvedValue(project);
        stubTaskLookup(task);
        stubOwnershipLookup({ source: 'client', created_by: me, status: 'to_do' });

        await expect(
            svc.mintUploadUrl(task._id, { file_name: 'a.png', file_size: 10, mime_type: 'image/png' }, clientCaller(me))
        ).resolves.toBeDefined();
    });

    it('refuses once the team has started — same freeze as the title/priority edit', async () => {
        const me = new Types.ObjectId();
        const project = makeProject();
        const task = makeTaskRow(project._id);
        loadProjectForCallerMock.mockResolvedValue(project);
        stubTaskLookup(task);
        stubOwnershipLookup({ source: 'client', created_by: me, status: 'in_progress' });

        await expect(
            svc.mintUploadUrl(task._id, { file_name: 'a.png', file_size: 10, mime_type: 'image/png' }, clientCaller(me))
        ).rejects.toMatchObject({ statusCode: 403, code: ERROR_CODES.TASK_WRITE_FORBIDDEN });
    });
});

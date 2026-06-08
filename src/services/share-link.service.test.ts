import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `share-link.service` (Step 24).
 *
 * Coverage focus:
 *   1. `createLink` — project-must-exist, owner_client_id must be an
 *      active CLIENT user, expires_at-in-the-past rejected, generic
 *      link (no owner) accepted, token uniqueness retry, audit row.
 *   2. `listLinks` — `active_only` filters out revoked + expired.
 *   3. `revokeLink` — sets revoked_at + revoked_by + reason="manual",
 *      idempotent on already-revoked rows (no save, no audit).
 *   4. `resolveLink` — 404 on unknown token, 410 GONE with code
 *      `SHARE_LINK_REVOKED` on revoked, 410 with `SHARE_LINK_EXPIRED`
 *      on expired, bumps last_accessed_at on the happy path.
 *   5. `revokeLinksForDeactivatedClient` — finds open links for the
 *      client only (skips revoked + non-owner), records reason
 *      "client_deactivated", returns the count.
 */

const {
    linkCreateMock,
    linkFindByIdMock,
    linkFindOneMock,
    linkFindMock,
    linkCountMock,
    projectExistsMock,
    projectFindByIdMock,
    sprintFindMock,
    storyFindMock,
    taskFindMock,
    userExistsMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    linkCreateMock: vi.fn(),
    linkFindByIdMock: vi.fn(),
    linkFindOneMock: vi.fn(),
    linkFindMock: vi.fn(),
    linkCountMock: vi.fn(),
    projectExistsMock: vi.fn(),
    projectFindByIdMock: vi.fn(),
    sprintFindMock: vi.fn(),
    storyFindMock: vi.fn(),
    taskFindMock: vi.fn(),
    userExistsMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/project-share-link.model.js', () => ({
    ProjectShareLink: {
        create: linkCreateMock,
        findById: linkFindByIdMock,
        findOne: linkFindOneMock,
        find: linkFindMock,
        countDocuments: linkCountMock,
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { exists: projectExistsMock, findById: projectFindByIdMock },
}));

vi.mock('../models/sprint.model.js', () => ({
    Sprint: { find: sprintFindMock },
}));

vi.mock('../models/story.model.js', () => ({
    Story: { find: storyFindMock },
}));

vi.mock('../models/task.model.js', () => ({
    Task: { find: taskFindMock },
}));

vi.mock('../models/user.model.js', () => ({
    User: { exists: userExistsMock },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./share-link.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const makeCaller = () => ({ id: new Types.ObjectId(), audit: undefined });

const makeLink = (overrides: Record<string, unknown> = {}) => {
    const l = {
        _id: new Types.ObjectId(),
        project_id: new Types.ObjectId(),
        // C9 — post-fix `token` is always null on newly created rows;
        // the lookup key is `token_hash`. The plaintext field is kept
        // as a nullable transitional field for the boot migration.
        token: null as string | null,
        token_hash: 'sha256-stub',
        owner_client_id: null as Types.ObjectId | null,
        created_by: new Types.ObjectId(),
        expires_at: null as Date | null,
        revoked_at: null as Date | null,
        revoked_by: null as Types.ObjectId | null,
        revoke_reason: null as 'manual' | 'client_deactivated' | null,
        last_accessed_at: null as Date | null,
        save: vi.fn(),
        toJSON: vi.fn(),
        ...overrides,
    };
    l.save.mockImplementation(async () => l);
    l.toJSON.mockImplementation(() => ({
        id: l._id.toString(),
        project_id: l.project_id.toString(),
        // toJSON reflects the on-disk shape; the service's `toPublic`
        // strips both `token` and `token_hash` so neither escapes the
        // API boundary.
        token: l.token,
        token_hash: l.token_hash,
        owner_client_id: l.owner_client_id?.toString() ?? null,
        expires_at: l.expires_at,
        revoked_at: l.revoked_at,
        revoke_reason: l.revoke_reason,
    }));
    return l;
};

const stubFindForList = (rows: ReturnType<typeof makeLink>[]): void => {
    linkFindMock.mockReturnValueOnce({
        sort: () => ({
            skip: () => ({
                limit: () => Promise.resolve(rows),
            }),
        }),
    });
    linkCountMock.mockResolvedValueOnce(rows.length);
};

beforeEach(() => {
    vi.resetAllMocks();
    projectExistsMock.mockResolvedValue({ _id: new Types.ObjectId() });
    userExistsMock.mockResolvedValue({ _id: new Types.ObjectId() });
});

// ─── createLink ──────────────────────────────────────────────────────────

describe('createLink', () => {
    it('rejects when the project does not exist', async () => {
        projectExistsMock.mockResolvedValueOnce(null);
        await expect(
            svc.createLink(new Types.ObjectId(), { owner_client_id: null, expires_at: null }, makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.PROJECT_NOT_FOUND });
        expect(linkCreateMock).not.toHaveBeenCalled();
    });

    it('rejects an owner_client_id that is not an active client user', async () => {
        userExistsMock.mockResolvedValueOnce(null);
        await expect(
            svc.createLink(
                new Types.ObjectId(),
                { owner_client_id: new Types.ObjectId().toString(), expires_at: null },
                makeCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE });
    });

    it('rejects expires_at in the past', async () => {
        await expect(
            svc.createLink(
                new Types.ObjectId(),
                { owner_client_id: null, expires_at: new Date(Date.now() - 60_000) },
                makeCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    });

    it('creates a generic non-expiring link (no owner_client_id, no expires_at)', async () => {
        const created = makeLink();
        linkCreateMock.mockResolvedValueOnce(created);

        const result = await svc.createLink(
            new Types.ObjectId(),
            { owner_client_id: null, expires_at: null },
            makeCaller()
        );

        // C9 — the create payload MUST set `token: null` and provide a
        // `token_hash`. The plaintext token never lands in Mongo.
        expect(linkCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                owner_client_id: null,
                expires_at: null,
                revoked_at: null,
                token: null,
                token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            })
        );
        // The raw token is returned to the caller exactly once. It must
        // be a non-empty base64url string distinct from the stub's
        // null `token` field.
        const { token } = result as { token: string };
        expect(typeof token).toBe('string');
        expect(token.length).toBeGreaterThan(20);
        // The returned token's SHA-256 must match the persisted
        // `token_hash` — establishes the round-trip invariant the
        // resolve path relies on.
        const persistedHash = (linkCreateMock.mock.calls[0]![0] as { token_hash: string }).token_hash;
        const { createHash } = await import('node:crypto');
        expect(createHash('sha256').update(token).digest('hex')).toBe(persistedHash);
    });

    it('retries on a unique-index 11000 collision and succeeds with a fresh token', async () => {
        const created = makeLink();
        linkCreateMock.mockRejectedValueOnce({ code: 11000, keyPattern: { token: 1 } }).mockResolvedValueOnce(created);

        await svc.createLink(new Types.ObjectId(), { owner_client_id: null, expires_at: null }, makeCaller());

        expect(linkCreateMock).toHaveBeenCalledTimes(2);
    });

    it('records share_link.create audit when caller carries an audit context', async () => {
        const created = makeLink();
        linkCreateMock.mockResolvedValueOnce(created);

        const caller = {
            id: new Types.ObjectId(),
            audit: { actor_id: new Types.ObjectId(), actor_role: 'manager' as const, ip: null, user_agent: null },
        };
        await svc.createLink(new Types.ObjectId(), { owner_client_id: null, expires_at: null }, caller);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [, payload] = recordAuditMock.mock.calls[0];
        expect((payload as { action: string }).action).toBe('share_link.create');
    });
});

// ─── listLinks ───────────────────────────────────────────────────────────

describe('listLinks', () => {
    it('omits the active-only filter by default (returns audit history)', async () => {
        stubFindForList([]);
        await svc.listLinks(new Types.ObjectId(), { page: 1, limit: 20, active_only: false });
        const filterArg = linkFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect('revoked_at' in filterArg).toBe(false);
        expect('$or' in filterArg).toBe(false);
    });

    it('filters out revoked + expired rows when active_only=true', async () => {
        stubFindForList([]);
        await svc.listLinks(new Types.ObjectId(), { page: 1, limit: 20, active_only: true });
        const filterArg = linkFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.revoked_at).toBeNull();
        expect(filterArg.$or).toEqual([{ expires_at: null }, { expires_at: { $gt: expect.any(Date) } }]);
    });
});

// ─── revokeLink ──────────────────────────────────────────────────────────

describe('revokeLink', () => {
    it('returns 404 SHARE_LINK_NOT_FOUND for an unknown id', async () => {
        linkFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.revokeLink(new Types.ObjectId(), makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.SHARE_LINK_NOT_FOUND,
        });
    });

    it('sets revoked_at + revoked_by + reason="manual" and audits', async () => {
        const link = makeLink();
        linkFindByIdMock.mockResolvedValueOnce(link);
        const caller = {
            id: new Types.ObjectId(),
            audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
        };

        await svc.revokeLink(link._id, caller);

        expect(link.revoked_at).toBeInstanceOf(Date);
        expect(link.revoked_by).toEqual(caller.id);
        expect(link.revoke_reason).toBe('manual');
        expect(link.save).toHaveBeenCalledTimes(1);
        expect(recordAuditMock).toHaveBeenCalledTimes(1);
    });

    it('is a no-op (no save, no audit) when the link is already revoked', async () => {
        const link = makeLink({ revoked_at: new Date('2026-01-01'), revoke_reason: 'manual' });
        linkFindByIdMock.mockResolvedValueOnce(link);
        await svc.revokeLink(link._id, makeCaller());
        expect(link.save).not.toHaveBeenCalled();
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── resolveLink (public) ────────────────────────────────────────────────

describe('resolveLink', () => {
    // The service strips enumeration fields via `.select(...)`, sorts,
    // then (H19) caps each list with `.limit(cap + 1)` so a clipped
    // result is detectable without a separate countDocuments. Mock
    // every step in the chain.
    const stubProjectChildren = (): void => {
        sprintFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ limit: () => Promise.resolve([]) }) }),
        });
        storyFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ limit: () => Promise.resolve([]) }) }),
        });
        taskFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ limit: () => Promise.resolve([]) }) }),
        });
    };

    /**
     * Project lookup chain: `findById(...).select(...)` returning a
     * promise of the project doc (or null for the deleted-project test).
     */
    const stubProjectFindById = (project: { _id: Types.ObjectId; toJSON: () => unknown } | null): void => {
        projectFindByIdMock.mockReturnValueOnce({
            select: () => Promise.resolve(project),
        });
    };

    it('returns 404 when the token is unknown', async () => {
        linkFindOneMock.mockResolvedValueOnce(null);
        await expect(svc.resolveLink('nonexistent')).rejects.toMatchObject({
            code: ERROR_CODES.SHARE_LINK_NOT_FOUND,
        });
    });

    it('returns 410 SHARE_LINK_REVOKED for revoked links', async () => {
        linkFindOneMock.mockResolvedValueOnce(
            makeLink({ revoked_at: new Date('2026-01-01'), revoke_reason: 'manual' })
        );
        await expect(svc.resolveLink('abc')).rejects.toMatchObject({
            code: ERROR_CODES.SHARE_LINK_REVOKED,
            statusCode: 410,
        });
    });

    it('returns 410 SHARE_LINK_EXPIRED for past expires_at', async () => {
        linkFindOneMock.mockResolvedValueOnce(makeLink({ expires_at: new Date(Date.now() - 60_000) }));
        await expect(svc.resolveLink('abc')).rejects.toMatchObject({
            code: ERROR_CODES.SHARE_LINK_EXPIRED,
            statusCode: 410,
        });
    });

    it('bumps last_accessed_at and returns project + sprints + stories + tasks', async () => {
        const link = makeLink();
        linkFindOneMock.mockResolvedValueOnce(link);
        stubProjectFindById({
            _id: link.project_id,
            toJSON: () => ({ id: link.project_id.toString(), name: 'Demo' }),
        });
        stubProjectChildren();

        const result = await svc.resolveLink('any-raw-token');

        expect(link.last_accessed_at).toBeInstanceOf(Date);
        expect(link.save).toHaveBeenCalledTimes(1);
        expect(result.project).toEqual({ id: link.project_id.toString(), name: 'Demo' });
        expect(result.sprints).toEqual([]);
        expect(result.stories).toEqual([]);
        expect(result.tasks).toEqual([]);
    });

    it('flags `truncated: { tasks: true }` when the task list hits the cap (H19)', async () => {
        const link = makeLink();
        linkFindOneMock.mockResolvedValueOnce(link);
        stubProjectFindById({
            _id: link.project_id,
            toJSON: () => ({ id: link.project_id.toString(), name: 'Demo' }),
        });
        // Sprint + story under cap → no truncation flag for them.
        sprintFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ limit: () => Promise.resolve([]) }) }),
        });
        storyFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ limit: () => Promise.resolve([]) }) }),
        });
        // Tasks: return cap + 1 to simulate an overflowed result.
        // The service pulls `limit(cap + 1)`; we hand back 1001 stub
        // task docs and the service slices to 1000 in the response.
        const tasksOverflow = Array.from({ length: 1001 }, (_, i) => ({
            toJSON: () => ({ id: `t${i}` }),
        }));
        taskFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ limit: () => Promise.resolve(tasksOverflow) }) }),
        });

        const result = await svc.resolveLink('any-raw-token');

        // Response is sliced to the cap.
        expect(result.tasks.length).toBe(1000);
        // truncated flag is set only for tasks.
        expect(result.truncated).toEqual({ tasks: true });
    });

    it('returns 404 when the project has been deleted but a live link still references it', async () => {
        const link = makeLink();
        linkFindOneMock.mockResolvedValueOnce(link);
        stubProjectFindById(null);

        await expect(svc.resolveLink('any-raw-token')).rejects.toMatchObject({
            code: ERROR_CODES.SHARE_LINK_NOT_FOUND,
        });
    });

    it('strips enumeration ObjectId fields via .select() on the public payload (regression)', async () => {
        // The public path must not echo `member_ids`, `client_ids`, or
        // `created_by` from the project doc; nor `created_by` /
        // `updated_by` from sprints/stories; nor `collaborator_ids` /
        // `created_by` / `updated_by` from tasks. Verified by asserting
        // each of those `.select(...)` calls received the negated
        // projection string.
        const link = makeLink();
        linkFindOneMock.mockResolvedValueOnce(link);
        const projectSelectArgs: string[] = [];
        const sprintSelectArgs: string[] = [];
        const storySelectArgs: string[] = [];
        const taskSelectArgs: string[] = [];
        projectFindByIdMock.mockReturnValueOnce({
            select: (arg: string) => {
                projectSelectArgs.push(arg);
                return Promise.resolve({
                    _id: link.project_id,
                    toJSON: () => ({ id: link.project_id.toString() }),
                });
            },
        });
        // H19 — chain is now `select().sort().limit()`. Mock all three
        // levels so the production `.limit(cap + 1)` call resolves.
        sprintFindMock.mockReturnValueOnce({
            select: (arg: string) => {
                sprintSelectArgs.push(arg);
                return { sort: () => ({ limit: () => Promise.resolve([]) }) };
            },
        });
        storyFindMock.mockReturnValueOnce({
            select: (arg: string) => {
                storySelectArgs.push(arg);
                return { sort: () => ({ limit: () => Promise.resolve([]) }) };
            },
        });
        taskFindMock.mockReturnValueOnce({
            select: (arg: string) => {
                taskSelectArgs.push(arg);
                return { sort: () => ({ limit: () => Promise.resolve([]) }) };
            },
        });

        await svc.resolveLink('any-raw-token');

        expect(projectSelectArgs[0]).toContain('-member_ids');
        expect(projectSelectArgs[0]).toContain('-client_ids');
        expect(projectSelectArgs[0]).toContain('-created_by');
        expect(sprintSelectArgs[0]).toContain('-created_by');
        expect(storySelectArgs[0]).toContain('-created_by');
        expect(storySelectArgs[0]).toContain('-updated_by');
        expect(taskSelectArgs[0]).toContain('-collaborator_ids');
        expect(taskSelectArgs[0]).toContain('-created_by');
        expect(taskSelectArgs[0]).toContain('-updated_by');
    });

    it('does not echo revoke_reason on the public 410 (regression — leaks client-deactivated state)', async () => {
        // The internal audit log keeps the reason; the public 410 must
        // NOT, otherwise an attacker holding a stale token can detect
        // that the link was revoked because a specific client account
        // was deactivated.
        linkFindOneMock.mockResolvedValueOnce(
            makeLink({ revoked_at: new Date('2026-01-01'), revoke_reason: 'client_deactivated' })
        );
        try {
            await svc.resolveLink('abc');
            throw new Error('expected resolveLink to throw');
        } catch (err) {
            const e = err as { details?: Record<string, unknown> };
            expect(e.details).toBeDefined();
            expect(e.details).not.toHaveProperty('revoke_reason');
            // We DO surface revoked_at — it's already implied by the
            // 410 status and doesn't disclose anything about the
            // underlying account.
            expect(e.details).toHaveProperty('revoked_at');
        }
    });
});

// ─── revokeLinksForDeactivatedClient ─────────────────────────────────────

describe('revokeLinksForDeactivatedClient', () => {
    it('revokes every open link owned by the client and returns the count', async () => {
        const clientId = new Types.ObjectId();
        const a = makeLink({ owner_client_id: clientId });
        const b = makeLink({ owner_client_id: clientId });
        linkFindMock.mockResolvedValueOnce([a, b]);

        const result = await svc.revokeLinksForDeactivatedClient({
            client_id: clientId,
            revoked_by: new Types.ObjectId(),
        });

        expect(result).toEqual({ revoked_count: 2 });
        expect(a.revoke_reason).toBe('client_deactivated');
        expect(b.revoke_reason).toBe('client_deactivated');
        expect(a.save).toHaveBeenCalled();
        expect(b.save).toHaveBeenCalled();
        // Filter targets owner_client_id + open (revoked_at: null) only.
        expect(linkFindMock).toHaveBeenCalledWith({ owner_client_id: clientId, revoked_at: null });
    });

    it('never throws — a load failure is swallowed and returns count 0', async () => {
        linkFindMock.mockRejectedValueOnce(new Error('mongo down'));
        await expect(
            svc.revokeLinksForDeactivatedClient({
                client_id: new Types.ObjectId(),
                revoked_by: new Types.ObjectId(),
            })
        ).resolves.toEqual({ revoked_count: 0 });
    });

    it('continues the cascade past a per-link save failure', async () => {
        const a = makeLink();
        const b = makeLink();
        a.save.mockRejectedValueOnce(new Error('save failed'));
        linkFindMock.mockResolvedValueOnce([a, b]);

        const result = await svc.revokeLinksForDeactivatedClient({
            client_id: new Types.ObjectId(),
            revoked_by: new Types.ObjectId(),
        });

        // a's save threw → not counted; b's save succeeded → counted.
        expect(result.revoked_count).toBe(1);
        expect(b.revoke_reason).toBe('client_deactivated');
    });
});

// ─── C9 — token hashing invariants ────────────────────────────────────────

describe('resolveLink — C9 hashed-token lookup', () => {
    it('looks up by sha256(token), never by raw plaintext', async () => {
        // Find returns null (token doesn't exist); we only care about
        // the QUERY shape passed to findOne.
        linkFindOneMock.mockResolvedValueOnce(null);
        await expect(svc.resolveLink('public-share-token-abc')).rejects.toMatchObject({
            code: ERROR_CODES.SHARE_LINK_NOT_FOUND,
        });

        const { createHash } = await import('node:crypto');
        const expected = createHash('sha256').update('public-share-token-abc').digest('hex');
        expect(linkFindOneMock).toHaveBeenCalledWith({ token_hash: expected });
        // Confirm the raw token NEVER appears in the query — defence
        // against an accidental dual-read regression.
        const queryArg = linkFindOneMock.mock.calls[0]![0] as Record<string, unknown>;
        expect(queryArg).not.toHaveProperty('token');
    });
});

describe('migrateShareLinkTokensToHashed — C9 boot migration', () => {
    it('hashes every legacy plaintext token in place and clears the plaintext field', async () => {
        const row = {
            _id: new Types.ObjectId(),
            token: 'pre-c9-raw-token-xyz',
            token_hash: '',
            save: vi.fn(),
        };
        row.save.mockImplementation(async () => row);
        // Find().select() chain.
        linkFindMock.mockReturnValueOnce({ select: () => Promise.resolve([row]) });

        const { migrated, failed } = await svc.migrateShareLinkTokensToHashed();

        const { createHash } = await import('node:crypto');
        const expected = createHash('sha256').update('pre-c9-raw-token-xyz').digest('hex');
        expect(row.token_hash).toBe(expected);
        expect(row.token).toBeNull();
        expect(row.save).toHaveBeenCalledTimes(1);
        expect(migrated).toBe(1);
        expect(failed).toBe(0);
    });

    it('is a no-op on already-hashed rows (idempotent — token field already null)', async () => {
        // Find filters to `{ token: { $type: 'string', $ne: null } }`,
        // so post-migration rows (token: null) never reach the loop.
        // Verify the filter shape: it must NOT pick up null-token rows.
        linkFindMock.mockReturnValueOnce({ select: () => Promise.resolve([]) });

        const result = await svc.migrateShareLinkTokensToHashed();

        expect(result).toEqual({ migrated: 0, failed: 0 });
        expect(linkFindMock).toHaveBeenCalledWith({
            token: { $type: 'string', $ne: null },
        });
    });

    it('continues past a per-row save failure (counts the success, logs the failure)', async () => {
        const ok = {
            _id: new Types.ObjectId(),
            token: 'ok-token',
            token_hash: '',
            save: vi.fn(),
        };
        ok.save.mockImplementation(async () => ok);
        const bad = {
            _id: new Types.ObjectId(),
            token: 'bad-token',
            token_hash: '',
            save: vi.fn().mockRejectedValueOnce(new Error('save failed')),
        };
        linkFindMock.mockReturnValueOnce({ select: () => Promise.resolve([bad, ok]) });

        const { migrated, failed } = await svc.migrateShareLinkTokensToHashed();

        expect(migrated).toBe(1);
        expect(failed).toBe(1);
        expect(ok.token).toBeNull();
    });

    it('never throws — a cursor failure returns counts of 0', async () => {
        linkFindMock.mockReturnValueOnce({
            select: () => Promise.reject(new Error('mongo down')),
        });
        await expect(svc.migrateShareLinkTokensToHashed()).resolves.toEqual({
            migrated: 0,
            failed: 0,
        });
    });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

const { searchItemsMock } = vi.hoisted(() => ({
    searchItemsMock: vi.fn(),
}));

vi.mock('./search.service.js', () => ({
    search: searchItemsMock,
}));

const { listActions, getCommandPalette } = await import('./command-palette.service.js');
import { COMMAND_PALETTE_ACTIONS } from '../constants/command-palette.js';
import { PERMISSIONS } from '../constants/permissions.js';

/**
 * Unit tests for the command-palette service (Step 49).
 *
 * The service is a pure in-memory filter — no DB, no I/O — so every
 * test is synchronous and the catalog itself is the fixture. We
 * deliberately use the real catalog (rather than a mock list) so a
 * regression that drops a permission gate or mistypes a key surfaces
 * here.
 */

const catalogKey = (key: string): { permission?: string } => {
    const entry = COMMAND_PALETTE_ACTIONS.find((a) => a.key === key);
    if (!entry) throw new Error(`catalog missing key ${key} — test fixture out of date`);
    return entry;
};

describe('listActions — permission filter', () => {
    it('returns every action for a caller with the system.admin wildcard', () => {
        // Admin's whole point is "passes any gate". The wildcard
        // short-circuits the per-action permission check; the entire
        // catalog should surface verbatim.
        const out = listActions(undefined, { permissions: [PERMISSIONS.SYSTEM_ADMIN] });
        expect(out.data).toHaveLength(COMMAND_PALETTE_ACTIONS.length);
    });

    it('recognises a legacy admin token (role="admin" + no permissions claim) as full-catalog admin', () => {
        // Pre-Step-47 JWTs don't carry the `permissions` claim. The
        // `requirePermission` middleware accepts them via the legacy-
        // admin carve-out (`role === 'admin'`); the command palette
        // must do the same so the operator's Cmd-K modal isn't
        // silently stripped to navigation-only during the migration
        // window. Test passes a token shape that mimics a pre-deploy
        // admin: empty permissions array but legacy `role: 'admin'`.
        const out = listActions(undefined, { permissions: [], role: 'admin' });
        expect(out.data).toHaveLength(COMMAND_PALETTE_ACTIONS.length);
    });

    it('also recognises legacy admin via role_keys (post-Step-47, pre-permissions-claim window)', () => {
        // Belt + braces — a token in the very narrow window where
        // `role_keys` was populated but `permissions` was not (e.g.
        // a partial-deploy state) still surfaces the full catalog.
        const out = listActions(undefined, { permissions: [], role: 'employee', role_keys: ['admin'] });
        expect(out.data).toHaveLength(COMMAND_PALETTE_ACTIONS.length);
    });

    it('returns ONLY navigation actions (and any matching held perms) for a permission-less caller', () => {
        // A user with `permissions: []` has effectively just logged
        // in but has no role assignments. Navigation entries (no
        // `permission` field) should surface; everything else
        // should drop. Pin the count via a count of catalog entries
        // without a `permission` field.
        const navOnlyCount = COMMAND_PALETTE_ACTIONS.filter((a) => !a.permission).length;
        const out = listActions(undefined, { permissions: [] });
        expect(out.data).toHaveLength(navOnlyCount);
        expect(out.data.every((a) => !a.permission)).toBe(true);
    });

    it('filters to navigation + the single permission held by the caller', () => {
        // Concrete employee-style example: hold only LEAVE_REQUEST_WRITE.
        // Should see navigation entries + the "Apply for leave" action,
        // but NOT "Review pending leave requests" (different permission).
        const out = listActions(undefined, { permissions: [PERMISSIONS.LEAVE_REQUEST_WRITE] });
        const keys = out.data.map((a) => a.key);
        expect(keys).toContain('leave_request.apply'); // gated on LEAVE_REQUEST_WRITE
        expect(keys).not.toContain('leave_request.review'); // gated on LEAVE_REQUEST_APPROVE
        expect(keys).toContain('nav.dashboard'); // ungated nav entry
    });

    it("admin's catalog and a permission-less caller's catalog differ by exactly the gated entries", () => {
        // Sanity: the difference between "admin catalog" and "no-perms
        // catalog" must equal the count of catalog entries that have
        // a `permission` field. If the sets diverge by anything else,
        // the wildcard fast-path or the "no permission = public"
        // shortcut has regressed.
        const adminOut = listActions(undefined, { permissions: [PERMISSIONS.SYSTEM_ADMIN] });
        const noneOut = listActions(undefined, { permissions: [] });
        const gatedCount = COMMAND_PALETTE_ACTIONS.filter((a) => a.permission !== undefined).length;
        expect(adminOut.data.length - noneOut.data.length).toBe(gatedCount);
    });

    it('catalog invariant: every gated entry references a real permission value', () => {
        // Defence in depth — a typo in the catalog (`PERMISSIONS.PROJECT_WRITE_TYPO`)
        // would compile-fail at the catalog file, but a future contributor
        // adding entries via string literal would slip past TypeScript.
        // The test fixture is the constants file itself; we check that every
        // declared permission resolves to a known value.
        const knownPerms = new Set<string>(Object.values(PERMISSIONS));
        for (const action of COMMAND_PALETTE_ACTIONS) {
            if (action.permission) {
                expect(knownPerms.has(action.permission)).toBe(true);
            }
        }
    });
});

describe('listActions — query filter', () => {
    it('substring-matches against the action label (case-insensitive)', () => {
        // "leave" should surface every leave-related action that's in
        // the caller's permitted slice. We give the caller all leave
        // permissions to factor out the permission filter.
        const out = listActions('leave', {
            permissions: [
                PERMISSIONS.LEAVE_REQUEST_WRITE,
                PERMISSIONS.LEAVE_REQUEST_APPROVE,
                PERMISSIONS.LEAVE_BALANCE_READ_TEAM,
                PERMISSIONS.LEAVE_TYPE_WRITE,
            ],
        });
        const keys = out.data.map((a) => a.key);
        expect(keys).toContain('leave_request.apply');
        expect(keys).toContain('leave_request.review');
        expect(keys).toContain('nav.my_leaves'); // navigation, no permission
        // Sanity: dashboard navigation does NOT contain "leave" — should drop.
        expect(keys).not.toContain('nav.dashboard');
    });

    it('substring-matches against keywords (so "new" finds "Create new project")', () => {
        // Keywords let users discover actions via natural verbs that
        // aren't in the canonical label. "new" → finds creation actions.
        const out = listActions('new', { permissions: [PERMISSIONS.SYSTEM_ADMIN] });
        const keys = out.data.map((a) => a.key);
        expect(keys).toContain('project.create'); // label contains "new"
        expect(keys).toContain('user.create'); // keyword "new"
    });

    it('returns an empty list when the query matches no permitted action', () => {
        // No catalog entry contains "nonexistent". Empty list, not an
        // error — Cmd-K's UX is "show empty state" on zero matches.
        const out = listActions('nonexistent', { permissions: [PERMISSIONS.SYSTEM_ADMIN] });
        expect(out.data).toEqual([]);
    });

    it('preserves catalog order in the filtered result', () => {
        // The FE relies on insertion order within categories for stable
        // rendering. Filter must not re-order — only drop. We pick a
        // multi-match query and assert the surviving entries appear
        // in the same relative order they do in the catalog.
        const out = listActions('report', { permissions: [PERMISSIONS.REPORT_READ] });
        const outOrder = out.data.map((a) => a.key);
        const catalogOrder = COMMAND_PALETTE_ACTIONS.filter((a) => outOrder.includes(a.key)).map((a) => a.key);
        expect(outOrder).toEqual(catalogOrder);
    });
});

describe('listActions — combined permission + query filter', () => {
    it('drops actions that match the query but exceed caller permissions', () => {
        // An employee searching "billing" should NOT see the billing
        // report action (gated on REPORT_READ which they don't have).
        // Pin the contract: permission filter is independent of query
        // filter — both must pass.
        const out = listActions('billing', { permissions: [] });
        const keys = out.data.map((a) => a.key);
        expect(keys).not.toContain('report.billing');
        expect(keys).not.toContain('billing_rate.list');
    });
});

describe('catalog snapshot — every key is unique', () => {
    it('no duplicate action keys across the catalog', () => {
        // Keys are stable identifiers used for FE icon mapping +
        // analytics. A duplicate would silently shadow telemetry.
        const seen = new Set<string>();
        for (const action of COMMAND_PALETTE_ACTIONS) {
            expect(seen.has(action.key)).toBe(false);
            seen.add(action.key);
        }
    });

    it('every entry has the catalogKey lookup helper happy (test fixture sanity)', () => {
        // Belt + braces: confirm the lookup helper used elsewhere in
        // the suite resolves every catalog entry.
        for (const action of COMMAND_PALETTE_ACTIONS) {
            expect(catalogKey(action.key).permission).toBe(action.permission);
        }
    });
});

// ─── Unified getCommandPalette ──────────────────────────────────────────

describe('getCommandPalette — unified Cmd-K surface', () => {
    const userId = new Types.ObjectId();
    const adminCaller = {
        id: userId,
        permissions: [PERMISSIONS.SYSTEM_ADMIN],
        role: 'admin',
    };

    beforeEach(() => {
        searchItemsMock.mockReset();
    });

    it('returns full action catalog + EMPTY items when no q is supplied', async () => {
        // First-open Cmd-K state — modal renders all actions immediately
        // without paying for a Mongo search round-trip. Items buckets
        // are present but empty so the FE can render the four columns
        // without a null-check.
        const out = await getCommandPalette({}, adminCaller);

        expect(out.actions).toHaveLength(COMMAND_PALETTE_ACTIONS.length);
        expect(out.items).toEqual({ users: [], projects: [], sprints: [], tasks: [] });
        // Skip the DB hit. Pin the optimisation so a regression that
        // always calls search surfaces here.
        expect(searchItemsMock).not.toHaveBeenCalled();
    });

    it('returns filtered actions + EMPTY items when q is below SEARCH_MIN_QUERY_LENGTH', async () => {
        // Single-char `q` filters the actions catalog (the user is
        // typing) but doesn't kick off a 4-collection regex scan that
        // would match almost everything. UX is "actions react on every
        // keystroke; items wait for ≥ 2 chars".
        const out = await getCommandPalette({ q: 'a' }, adminCaller);

        // Actions are filtered (we just don't pin the count — depends
        // on how many catalog entries contain "a").
        expect(out.actions.length).toBeGreaterThan(0);
        expect(out.actions.length).toBeLessThan(COMMAND_PALETTE_ACTIONS.length);
        expect(out.items).toEqual({ users: [], projects: [], sprints: [], tasks: [] });
        expect(searchItemsMock).not.toHaveBeenCalled();
    });

    it('delegates to search.service when q ≥ SEARCH_MIN_QUERY_LENGTH', async () => {
        // The Cmd-K typeahead trigger point. Once the query is
        // specific enough, hit the resource buckets in parallel with
        // the action filter.
        const fakeItems = {
            users: [{ id: 'u1', full_name: 'Alice', role: 'employee' }],
            projects: [],
            sprints: [],
            tasks: [],
        };
        searchItemsMock.mockResolvedValueOnce(fakeItems);

        const out = await getCommandPalette({ q: 'al' }, adminCaller);

        expect(searchItemsMock).toHaveBeenCalledTimes(1);
        const [searchQuery, searchCaller] = searchItemsMock.mock.calls[0];
        expect(searchQuery.q).toBe('al');
        expect(searchCaller.id).toBe(userId);
        // Search-side caller needs a real `RoleType` for visibility
        // scoping — the unified service narrows before calling.
        expect(searchCaller.role).toBe('admin');
        expect(out.items).toEqual(fakeItems);
        expect(out.actions.length).toBeGreaterThan(0);
    });

    it('skips search.service when the caller has no recognisable RoleType (defence in depth)', async () => {
        // A token whose `role` is a custom-role key (not in the legacy
        // `ROLES` enum) couldn't be safely passed to search — its
        // visibility filter branches on `caller.role === ROLES.X`.
        // Skip the items fetch and surface actions-only; the FE still
        // renders Cmd-K usefully and the user can navigate via
        // shortcuts even though typeahead is degraded.
        const out = await getCommandPalette(
            { q: 'project' },
            { id: userId, permissions: [PERMISSIONS.PROJECT_READ], role: 'auditor' as string }
        );

        expect(out.items).toEqual({ users: [], projects: [], sprints: [], tasks: [] });
        expect(searchItemsMock).not.toHaveBeenCalled();
        expect(out.actions.length).toBeGreaterThan(0);
    });
});

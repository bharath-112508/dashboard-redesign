import { Types } from 'mongoose';

import { COMMAND_PALETTE_ACTIONS, type CommandPaletteAction } from '../constants/command-palette.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { SYSTEM_ROLE_KEYS } from '../constants/role-keys.js';
import { SEARCH_DEFAULT_LIMIT, SEARCH_MIN_QUERY_LENGTH } from '../constants/search.js';
import { search as searchItems, type SearchResult } from './search.service.js';
import type { CommandPaletteQuery } from '../validators/command-palette.validator.js';

/**
 * Command-palette service — Step 49.
 *
 * The Cmd-K modal is one keyboard surface that fans out to two
 * underlying capabilities:
 *
 *   1. **Actions** — verbs (the static `COMMAND_PALETTE_ACTIONS`
 *      catalog) filtered to the caller's permissions + (optionally)
 *      by a substring match against the supplied query.
 *   2. **Items** — typeahead resource hits (users / projects /
 *      sprints / tasks). Delegated to `search.service.search` so the
 *      Cmd-K surface and the dedicated `/search` endpoint share one
 *      implementation; we never want them to drift on visibility
 *      scoping.
 *
 * The unified `getCommandPalette` runs both in parallel and returns
 * `{actions, items}` in one envelope so the FE makes one HTTP call
 * to render Cmd-K. When `q` is absent or below `SEARCH_MIN_QUERY_LENGTH`
 * the items buckets are returned empty without touching Mongo — the
 * UX is "first open shows actions immediately, items appear once the
 * user has typed enough to disambiguate".
 *
 * Action filter is pure in-memory (catalog is a constant, total cost
 * < 1 KiB of work). The items fetch is the only DB-touching call;
 * its visibility scoping comes from `search.service` unchanged.
 */

export interface CommandPaletteCaller {
    permissions: readonly string[];
    /**
     * Legacy denormalised role string (pre-Step-47 JWT field). Populated
     * on every issued token; we read it to recognise admins whose JWT
     * was minted before the `permissions` claim landed (any token in
     * flight from the deploy window). Tokens minted post-Step-47 also
     * carry `system.admin` in `permissions`, so both signals point to
     * the same answer for fresh logins — the legacy field exists only
     * to bridge the transition.
     */
    role?: string;
    /**
     * Resolved role keys (Step-47 field). Used for the same legacy-
     * admin recognition: a token with `role_keys.includes('admin')` is
     * always an admin even if the wildcard was missed when the
     * `permissions` array was assembled.
     */
    role_keys?: readonly string[];
}

const SYSTEM_ADMIN: string = PERMISSIONS.SYSTEM_ADMIN;

/**
 * Mirror of `auth.middleware.isCallerAdmin` — recognise admins via
 * EITHER the legacy `role` field OR the new `role_keys` array, in
 * addition to the `system.admin` wildcard inside `permissions`. Keeps
 * the command-palette in lock-step with `requirePermission`'s
 * back-compat shim so a legacy admin token doesn't see a stripped
 * catalog while every other surface still treats them as admin.
 */
const isCallerAdmin = (caller: CommandPaletteCaller): boolean => {
    if (caller.permissions.includes(SYSTEM_ADMIN)) return true;
    if (caller.role === ROLES.ADMIN) return true;
    return (caller.role_keys ?? []).includes(SYSTEM_ROLE_KEYS.ADMIN);
};

const callerCanInvoke = (action: CommandPaletteAction, held: ReadonlySet<string>, isAdmin: boolean): boolean => {
    // Wildcard / legacy-admin fast-path — admin sees everything.
    if (isAdmin) return true;
    // No `permission` field → public-to-authenticated (every caller passes).
    if (!action.permission) return true;
    return held.has(action.permission);
};

/**
 * Lowercase + match substring against an action's label + keywords.
 * Returns true when the query matches any token; false-y on empty
 * query (the caller short-circuits before invoking us so we don't
 * need to defend against undefined here).
 */
const actionMatchesQuery = (action: CommandPaletteAction, qLower: string): boolean => {
    if (action.label.toLowerCase().includes(qLower)) return true;
    if (action.keywords) {
        for (const k of action.keywords) {
            if (k.toLowerCase().includes(qLower)) return true;
        }
    }
    return false;
};

/**
 * Pure-action catalog filter. Returns the catalog scoped to the
 * caller's permissions + (optionally) by substring match against
 * `q`. Used internally by `getCommandPalette` and exported so unit
 * tests can exercise the action filter in isolation.
 */
export const listActions = (q: string | undefined, caller: CommandPaletteCaller): { data: CommandPaletteAction[] } => {
    const held = new Set<string>(caller.permissions);
    const isAdmin = isCallerAdmin(caller);
    const qLower = q ? q.toLowerCase() : null;

    const data: CommandPaletteAction[] = [];
    for (const action of COMMAND_PALETTE_ACTIONS) {
        if (!callerCanInvoke(action, held, isAdmin)) continue;
        if (qLower && !actionMatchesQuery(action, qLower)) continue;
        data.push(action);
    }
    return { data };
};

// ─── Empty items helper ─────────────────────────────────────────────

const EMPTY_ITEMS: SearchResult = {
    users: [],
    projects: [],
    sprints: [],
    tasks: [],
};

// ─── Unified Cmd-K surface ─────────────────────────────────────────

export interface CommandPaletteResult {
    actions: CommandPaletteAction[];
    items: SearchResult;
}

/**
 * The combined caller — extends `CommandPaletteCaller` with the
 * Mongo `_id` (needed by `search.service` for visibility scoping)
 * and the legacy `role` is reused for the Search-side caller shape
 * too. The role required for search **must** be a real `RoleType`
 * (search's visibility filter branches on it for the
 * member-vs-client scoping); we narrow before calling.
 */
export interface CommandPaletteFullCaller extends CommandPaletteCaller {
    id: Types.ObjectId;
}

/**
 * `GET /command-palette[?q=...]` — returns actions + items together.
 *
 * Items are fetched only when `q` meets `SEARCH_MIN_QUERY_LENGTH`
 * (currently 2 chars). A 1-char `q` filters actions but leaves items
 * empty — that's the typeahead UX (actions on every keystroke,
 * resource hits once the query is specific enough to be useful).
 *
 * Action filter and items fetch run in parallel via `Promise.all`;
 * the wall-time floor is the slower of the two (which is always
 * search since actions are in-memory).
 */
export const getCommandPalette = async (
    query: CommandPaletteQuery,
    caller: CommandPaletteFullCaller
): Promise<CommandPaletteResult> => {
    const actionsResult = listActions(query.q, caller);

    // Search needs a real `RoleType` for its visibility scoping. The
    // command-palette caller only requires a `string` role (so we can
    // accept legacy admin tokens), but search's filter logic relies on
    // the enum. If the caller's role isn't in `RoleType`, we skip the
    // items fetch — they get actions-only, which is the safe default.
    const searchableRole = isSearchableRole(caller.role) ? (caller.role as RoleType) : null;

    const shouldFetchItems =
        query.q !== undefined && query.q.length >= SEARCH_MIN_QUERY_LENGTH && searchableRole !== null;

    const items = shouldFetchItems
        ? await searchItems(
              { q: query.q!, types: undefined, limit: SEARCH_DEFAULT_LIMIT },
              { id: caller.id, role: searchableRole as RoleType }
          )
        : EMPTY_ITEMS;

    return { actions: actionsResult.data, items };
};

const SEARCHABLE_ROLES = new Set<string>(Object.values(ROLES));

const isSearchableRole = (role: string | undefined): boolean => {
    if (!role) return false;
    return SEARCHABLE_ROLES.has(role);
};

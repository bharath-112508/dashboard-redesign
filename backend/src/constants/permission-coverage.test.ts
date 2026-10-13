import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PERMISSIONS } from './permissions.js';

/**
 * Permission coverage — every catalogued permission must gate at least one route.
 *
 * ── What this guards ─────────────────────────────────────────────────────
 *
 * A permission that is declared in `permissions.ts`, bundled into a system
 * role, and rendered as assignable in the FE Roles UI, but referenced by NO
 * route file, is a **control that appears wired and is not**. Granting or
 * revoking it changes nothing, and there is no way to tell that from reading
 * the catalog — you have to trace each constant to its use site.
 *
 * See `03-invariants.md` §2 ("Declaration does not imply enforcement") and the
 * `PENDING_WORK.md` entry "Controls that appear wired and are not".
 *
 * ── What a failure means ─────────────────────────────────────────────────
 *
 * Exactly one of two things, and they have opposite fixes:
 *
 *   1. **The permission is vestigial.** Nothing was ever meant to gate on it,
 *      or the surface it guarded was removed. Fix: delete the constant from
 *      `permissions.ts`, drop it from any bundle in
 *      `system-role-definitions.ts`, and remove it from the FE mirror at
 *      `viljetech-platform-frontend/src/lib/permissions.ts`.
 *
 *   2. **A route that should be gated is not.** The permission describes a
 *      real capability and someone forgot the `requirePermission(...)`, or the
 *      route relies on a broader gate that happens to overlap. Fix: add the
 *      gate. This is the more serious reading — it means an endpoint is open
 *      to anyone past the router-level check.
 *
 * Decide which case you are in by asking whether the capability should be
 * separately grantable. Do NOT add the constant to `ALLOWLIST` to make this
 * pass; the allowlist is for permissions that are enforced somewhere other
 * than a route file, and there is currently exactly one.
 *
 * ── The three original failures, and how each was resolved ───────────────
 *
 * This test was committed red against three permissions. All three are now
 * closed, and none by weakening the test:
 *
 *   - `settings.read`                  — gated. `GET /settings` now carries
 *                                        `requirePermission(SETTINGS_READ)`.
 *                                        Every role's bundle holds it, so no
 *                                        caller lost access; the catalog just
 *                                        stopped claiming a control the API
 *                                        didn't have. Redaction by role is
 *                                        unchanged.
 *   - `attendance.correction_request`  — gated, and it was not vestigial.
 *                                        `POST`/`GET /attendance/correction-
 *                                        requests` ran on the `authenticate`
 *                                        baseline alone, and `listCorrections`
 *                                        narrows to `user_id` only for the
 *                                        EMPLOYEE role — so a client-side
 *                                        caller fell through to the reviewer
 *                                        branch and read everyone else's
 *                                        requests.
 *   - `timesheet.edit_out_of_window`   — now enforced by the permission rather
 *                                        than `isManagerOrAdmin(caller.role)`,
 *                                        in `timesheet.service.ts`. It stays
 *                                        allowlisted below because the route
 *                                        cannot express it: `PATCH /timesheets/
 *                                        :id` serves ordinary in-window
 *                                        self-edits too, so a route-level gate
 *                                        would block those.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(HERE, '..', 'routes');

/**
 * Permissions enforced somewhere other than a route file.
 *
 * `SYSTEM_ADMIN` is the wildcard: `requirePermission` short-circuits on it
 * internally (`held.includes(PERMISSIONS.SYSTEM_ADMIN) || isCallerAdmin(...)`),
 * so it satisfies every gate without ever being named by one. It is correct
 * for this to appear in no route file.
 *
 * `TIMESHEET_EDIT_OUT_OF_WINDOW` is enforced in `timesheet.service.ts`
 * (`canEditOutOfWindow`), on both the patch and the delete path, because the
 * endpoint it guards also serves in-window self-edits — a `requirePermission`
 * on the route would turn those away. It is a permission check, not a role
 * check: granting the bit to a custom role now genuinely confers the override.
 *
 * Anything added here needs a comment explaining where it IS enforced, or it
 * is just a silenced failure.
 */
const ALLOWLIST: readonly string[] = ['SYSTEM_ADMIN', 'TIMESHEET_EDIT_OUT_OF_WINDOW'];

const readRouteSources = (): string => {
    const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    // Guard against a path change silently turning this into a no-op test:
    // an empty read would make every permission "unreferenced" — or, if the
    // assertion were inverted, make them all pass.
    expect(files.length).toBeGreaterThan(0);
    return files.map((f) => readFileSync(join(ROUTES_DIR, f), 'utf8')).join('\n');
};

describe('permission coverage', () => {
    it('every catalogued permission is referenced by at least one route file', () => {
        const routeSource = readRouteSources();

        const unreferenced = Object.keys(PERMISSIONS)
            .filter((name) => !ALLOWLIST.includes(name))
            .filter((name) => !new RegExp(`PERMISSIONS\\.${name}\\b`).test(routeSource));

        expect(
            unreferenced,
            unreferenced.length === 0
                ? ''
                : [
                      '',
                      `${unreferenced.length} permission(s) are catalogued but gate no route:`,
                      ...unreferenced.map((n) => `  - ${n}  (${PERMISSIONS[n as keyof typeof PERMISSIONS]})`),
                      '',
                      'Each is EITHER vestigial (remove it from permissions.ts, the role',
                      'bundles, and the FE mirror) OR a route that should be gated is not',
                      '(add the requirePermission). See the block comment at the top of this',
                      'file, 03-invariants.md §2, and PENDING_WORK.md → "Controls that appear',
                      'wired and are not".',
                      '',
                      'Do not add them to ALLOWLIST to make this pass.',
                      '',
                  ].join('\n')
        ).toEqual([]);
    });

    it('the allowlist stays minimal and every entry is a real permission', () => {
        // A growing allowlist is how this test stops meaning anything. Raised
        // from 1 to 2 for `TIMESHEET_EDIT_OUT_OF_WINDOW`, which is enforced in
        // `timesheet.service.ts` because its endpoint also serves in-window
        // self-edits. Raise this again only for a permission that genuinely
        // cannot be expressed as a route gate, and say where it IS enforced in
        // the ALLOWLIST comment above.
        expect(ALLOWLIST.length).toBeLessThanOrEqual(2);
        for (const name of ALLOWLIST) {
            expect(Object.keys(PERMISSIONS)).toContain(name);
        }
    });
});

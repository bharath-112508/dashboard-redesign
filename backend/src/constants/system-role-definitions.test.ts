import { describe, expect, it } from 'vitest';

import { PERMISSIONS, type Permission } from './permissions.js';
import { SYSTEM_ROLE_DEFINITIONS } from './system-role-definitions.js';
import { SYSTEM_ROLE_KEYS } from './role-keys.js';

/**
 * Drift guard for the role-bundle ↔ permissions catalog (M9).
 *
 * The role-bundle list in `system-role-definitions.ts` references
 * `PERMISSIONS.X` constants. TypeScript catches typos at build time,
 * BUT — and this is the failure mode the test exists for — if a
 * permission constant is *renamed* in `permissions.ts`, every role
 * bundle that referenced the OLD name compiles cleanly because the
 * import resolves to the new constant... but the *string value* the
 * BE seeds into Mongo for that role bundle has now silently shifted.
 * Existing users whose role row was seeded with the old string value
 * stop getting that permission at the next role re-seed.
 *
 * The asserts below pin two contracts that catch the drift:
 *   1. Every permission value in any role bundle must exist in the
 *      canonical `PERMISSIONS` value set.
 *   2. Every system role key (`admin`, `manager`, `team_lead`,
 *      `employee`, `client`) must have exactly one definition.
 *
 * If the seeder ever stores or reads a permission string that isn't
 * a known PERMISSIONS value, the boot would silently drop it from
 * the user's effective set. The drift guard catches the static-side
 * of that bug at CI time.
 */

const PERMISSION_VALUES = new Set<string>(Object.values(PERMISSIONS));

describe('system-role-definitions drift guards', () => {
    it('every permission referenced in a role bundle exists in PERMISSIONS', () => {
        const offenders: Array<{ role: string; permission: string }> = [];
        for (const def of SYSTEM_ROLE_DEFINITIONS) {
            for (const p of def.permissions as readonly Permission[]) {
                if (!PERMISSION_VALUES.has(p)) {
                    offenders.push({ role: def.key, permission: p });
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('every SYSTEM_ROLE_KEY has exactly one role definition', () => {
        const definedKeys = SYSTEM_ROLE_DEFINITIONS.map((d) => d.key).sort();
        const expectedKeys = Object.values(SYSTEM_ROLE_KEYS).sort();
        expect(definedKeys).toEqual(expectedKeys);

        // No accidental duplicates (would manifest as the seeder
        // overwriting one definition with the other on the second
        // pass — silent in tests but surfaces in prod as "the role
        // got a permission set I didn't ask for").
        const counts = new Map<string, number>();
        for (const d of SYSTEM_ROLE_DEFINITIONS) {
            counts.set(d.key, (counts.get(d.key) ?? 0) + 1);
        }
        for (const [key, count] of counts.entries()) {
            expect({ key, count }).toEqual({ key, count: 1 });
        }
    });

    it('admin role holds the system.admin wildcard (and only the wildcard)', () => {
        // The wildcard model is load-bearing: middleware short-circuits
        // any `requirePermission(X)` for users with `system.admin`.
        // If the seeder ever inflates the admin bundle with explicit
        // permissions, the wildcard becomes redundant *and* removing
        // it later silently drops admin's access.
        const admin = SYSTEM_ROLE_DEFINITIONS.find((d) => d.key === SYSTEM_ROLE_KEYS.ADMIN);
        expect(admin).toBeDefined();
        expect(admin?.permissions).toEqual([PERMISSIONS.SYSTEM_ADMIN]);
    });

    it('client role does NOT hold system.admin (privilege escalation guard)', () => {
        // Defence-in-depth: a copy-paste accident on the client
        // bundle that included system.admin would silently grant
        // every client user every permission. Pin the negative.
        const client = SYSTEM_ROLE_DEFINITIONS.find((d) => d.key === SYSTEM_ROLE_KEYS.CLIENT);
        expect(client).toBeDefined();
        expect(client?.permissions).not.toContain(PERMISSIONS.SYSTEM_ADMIN);
    });

    // The money module (billing rates, cost rates, engagements, invoices,
    // Billing + Margin reports) is gated OFF for this phase — every one of
    // those endpoints 404s unless BILLING_MODULES_ENABLED=true. No default
    // role should advertise reaching them.
    //
    // `invoice.read` is the one that mattered: GET /engagements and
    // GET /invoices have no row scoping at all, so bundling it into `manager`
    // let every Manager read every client's contracts and bills. Re-adding it
    // means first scoping those two reads — this test is here to make that a
    // deliberate decision rather than a quiet regression.
    it('no system role bundles a money permission while the module is gated off', () => {
        const MONEY_PERMISSIONS: readonly string[] = [
            PERMISSIONS.BILLING_RATE_READ,
            PERMISSIONS.BILLING_RATE_WRITE,
            PERMISSIONS.COST_RATE_READ,
            PERMISSIONS.COST_RATE_WRITE,
            PERMISSIONS.INVOICE_READ,
            PERMISSIONS.INVOICE_WRITE,
        ];

        for (const def of SYSTEM_ROLE_DEFINITIONS) {
            // Admin holds only the wildcard, which is checked separately; it
            // reaches everything by design and is not a per-permission grant.
            if (def.key === SYSTEM_ROLE_KEYS.ADMIN) continue;
            const leaked = def.permissions.filter((p) => MONEY_PERMISSIONS.includes(p));
            expect(leaked, `role "${def.key}" bundles money permissions: ${leaked.join(', ')}`).toEqual([]);
        }
    });
});

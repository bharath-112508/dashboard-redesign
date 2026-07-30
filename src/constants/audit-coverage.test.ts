import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit.js';

/**
 * Audit-action coverage — every catalogued audit action must be written somewhere.
 *
 * Sibling of `permission-coverage.test.ts`, and it exists because that test's
 * absence in this dimension is what let a dead audit action sit unnoticed:
 * `salary_structure.update` was found by hand during the handover audit, not by
 * tooling. See `03-invariants.md` §2 ("Declaration does not imply enforcement")
 * and the `PENDING_WORK.md` entry "Controls that appear wired and are not",
 * where it is the fifth instance.
 *
 * ── What this guards ─────────────────────────────────────────────────────
 *
 * An action declared in `AUDIT_ACTIONS` and written by nothing is a control
 * that appears wired and is not. It is worse than merely tidy-able, because it
 * misleads in a specific direction: an engineer or an auditor reading the
 * catalog concludes that the operation is tracked, and the absence of those
 * rows in `audit_logs` reads as "it never happened" when it actually means
 * "it cannot happen". Those two are indistinguishable from outside the code.
 *
 * ── What a failure means ─────────────────────────────────────────────────
 *
 * Exactly one of two things, and they have opposite fixes:
 *
 *   1. **The action is dead.** Nothing performs the operation it names, or the
 *      operation was removed. Fix: delete the constant from `audit.ts`. Check
 *      first whether the FE mirrors it for filter dropdowns —
 *      `viljetech-platform-frontend/src/lib/audit-catalog.ts` is a manually
 *      synced copy and will need the same removal.
 *
 *   2. **A mutation that should be audited is not.** The action describes a
 *      real operation that someone forgot to record. Fix: call `recordAudit`
 *      in the owning service. This is the more serious reading — it means a
 *      state change is happening with no forensic trail, and the pre-PR
 *      checklist in `CLAUDE.md` ("every new mutating service writes an audit
 *      row") was missed.
 *
 * Decide which by looking for the operation, not the constant: if a service
 * mutates state that the action names, case 2 applies.
 *
 * ── Why `src/services/` and not "anywhere in src/" ───────────────────────
 *
 * Services are where mutations live, and `recordAudit` is a service-layer
 * concern by convention — controllers are supposed to stay HTTP-shape-only.
 * Widening the search to all of `src/` would make this test pass for an audit
 * written from a controller, which is exactly the layering violation worth
 * noticing. The two legitimate exceptions are allowlisted below with the file
 * that writes them, so the exception is documented rather than absorbed.
 *
 * ── Known failure at the time this test was written ──────────────────────
 *
 * One action fails, and is deliberately NOT allowlisted:
 *
 *   - `SALARY_STRUCTURE_UPDATE` (`salary_structure.update`) — referenced by
 *     nothing in `src/` at all. Its sibling `SALARY_STRUCTURE_CREATE` is
 *     written by `salary-structure.service.ts`; this one has no writer because
 *     there is no update path. `salary-structure.routes.ts` exposes GET / POST
 *     / GET :id and no more: salary structures are append-only by design, so a
 *     correction is a new version rather than an edit.
 *
 *     This is case 1 — the action is dead and the constant should be removed.
 *     **Do not "fix" it by adding an update endpoint**; append-only versioning
 *     is deliberate and documented in `docs/modules/payroll.md`.
 *
 * The red is the finding. Allowlisting it would recreate exactly the problem
 * this test exists to surface.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = join(HERE, '..', 'services');

/**
 * Actions deliberately written outside `src/services/`.
 *
 * Every entry must name the file that DOES write it. An entry without that
 * justification is a silenced failure, not an exception.
 */
const ALLOWLIST: readonly string[] = [
    // Written by `controllers/user.controller.ts`. The GDPR DSAR export streams
    // NDJSON straight from the controller rather than buffering a payload in a
    // service, so the audit row is recorded at the same layer as the stream.
    'USER_DATA_EXPORT',
    // Written by `jobs/runner.ts`. The cron runner is not a service; it audits
    // every job execution centrally so individual jobs don't each repeat it.
    'SYSTEM_JOB_RUN',
];

const readServiceSources = (): string => {
    const files = readdirSync(SERVICES_DIR, { recursive: true, encoding: 'utf8' }).filter(
        (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
    );
    // Guard against a path change silently turning this into a no-op test: an
    // empty read would mark every action unreferenced — or, if the assertion
    // were ever inverted, make them all pass.
    expect(files.length).toBeGreaterThan(0);
    return files.map((f) => readFileSync(join(SERVICES_DIR, f), 'utf8')).join('\n');
};

describe('audit-action coverage', () => {
    it('every catalogued audit action is written by at least one service', () => {
        const serviceSource = readServiceSources();

        const unwritten = Object.keys(AUDIT_ACTIONS)
            .filter((name) => !ALLOWLIST.includes(name))
            .filter((name) => !new RegExp(`AUDIT_ACTIONS\\.${name}\\b`).test(serviceSource));

        expect(
            unwritten,
            unwritten.length === 0
                ? ''
                : [
                      '',
                      `${unwritten.length} audit action(s) are catalogued but written by no service:`,
                      ...unwritten.map((n) => `  - ${n}  (${AUDIT_ACTIONS[n as keyof typeof AUDIT_ACTIONS]})`),
                      '',
                      'Each is EITHER dead (remove the constant from audit.ts, and from the',
                      'FE mirror at src/lib/audit-catalog.ts) OR a mutation that should be',
                      'audited is not (call recordAudit in the owning service). The second',
                      'reading is the serious one: a state change with no forensic trail.',
                      '',
                      'See the block comment at the top of this file, 03-invariants.md §2,',
                      'and PENDING_WORK.md → "Controls that appear wired and are not".',
                      '',
                      'Do not add them to ALLOWLIST to make this pass. An allowlist entry',
                      'must name the file that DOES write the action.',
                      '',
                  ].join('\n')
        ).toEqual([]);
    });

    it('the allowlist stays at its declared size and every entry is a real action', () => {
        // A growing allowlist is how this test stops meaning anything. Raising
        // this number is a deliberate act that needs the justifying comment
        // above the new entry.
        expect(ALLOWLIST.length).toBe(2);
        for (const name of ALLOWLIST) {
            expect(Object.keys(AUDIT_ACTIONS)).toContain(name);
        }
    });
});

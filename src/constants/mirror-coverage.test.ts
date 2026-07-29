import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * FE↔BE mirror coverage — the three hand-maintained catalogs must agree.
 *
 * Three files in the frontend are manual copies of a backend constant, kept in
 * sync by hand with nothing enforcing it:
 *
 *   permissions.ts    → src/lib/permissions.ts
 *   error-codes.ts    → src/lib/error-codes.ts
 *   audit.ts          → src/lib/audit-catalog.ts   (mirrors TWO enums)
 *
 * See `03-invariants.md` §22 and §24. Drift in any of them is silent: no build
 * error, no failing request, just a UI that quietly lacks an option, a message,
 * or a gate.
 *
 * ── Why one harness and not one assertion ────────────────────────────────
 *
 * The three mirrors do NOT share a correctness condition, which is why this is
 * a config table rather than a single rule:
 *
 *   - `permissions`  must be EXACTLY equal in both directions. A permission is
 *     either in the catalog or it is not; there is no such thing as a
 *     backend-only permission, because the FE mirror is what gates the UI.
 *
 *   - `error-codes`  is NOT exactly equal, legitimately. Several backend codes
 *     are log or storage codes that never reach a client — the FE has no use
 *     for them and should not carry them. Those are allowlisted below, each
 *     naming the file that uses it. Anything else backend-only is a finding.
 *
 *   - `audit-catalog` must be exactly equal: the FE catalog drives the filter
 *     dropdowns on `/admin/audit-logs`, so a backend action missing here is an
 *     action nobody can filter for, and an FE-only entry is a filter that can
 *     never match.
 *
 * A single "the two sets are equal" test would fail on ~12 error codes that are
 * correct as they are, and would therefore be turned off rather than fixed.
 *
 * ── Four catalogs, three files ───────────────────────────────────────────
 *
 * `audit-catalog.ts` mirrors two backend enums (`AUDIT_ACTIONS` and
 * `AUDIT_TARGET_KINDS`), so it contributes two rows. The count of rows is
 * deliberately not the count of mirrors.
 *
 * ── What a failure means ─────────────────────────────────────────────────
 *
 * **Missing from the frontend** — one of three things:
 *   1. Genuine drift. Add it to the FE mirror. This is the common case.
 *   2. The backend constant is internal and never reaches a client (error
 *      codes only). Add it to that mirror's `beOnlyAllowed`, **naming the file
 *      that uses it** — an entry without that justification is a silenced
 *      failure, not an exception.
 *   3. The backend constant is dead — referenced nowhere in `src/`. Delete it
 *      from the backend. Do not mirror a constant nothing uses.
 *
 * **Stale in the frontend** — the FE names something the backend does not.
 * Almost always a rename the mirror did not follow. Delete or rename it; there
 * is no legitimate reason for an FE-only entry in any of these three.
 *
 * ── Known failures at the time this test was written ─────────────────────
 *
 * `permissions` passes. The other two do not, and are committed red because the
 * red is the finding:
 *
 *   error-codes    SESSION_NOT_FOUND is thrown to clients by auth.service.ts
 *                  via AppError.notFound and is absent from the FE mirror —
 *                  case 1, real drift. Seven others are referenced NOWHERE in
 *                  src/ and are case 3, dead constants to delete:
 *                  AUDIT_ARCHIVE_INTEGRITY_FAILED, INVALID_EXPORT_FORMAT,
 *                  MAINTENANCE_MODE, PUSH_NOT_CONFIGURED,
 *                  TASK_TEMPLATE_RECURRENCE_INVALID,
 *                  TIMESHEET_GENERAL_CATEGORY_REQUIRED, UPLOAD_FAILED.
 *
 *   audit-catalog  38 actions and 12 target kinds missing from the FE, plus one
 *                  stale FE entry — `project.clients_update`, retired in the
 *                  clients → representatives rename. The backend now writes
 *                  `project.representatives_update`.
 *
 * Tracked in `PENDING_WORK.md` → "Coverage tests pending resolution".
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BE_ROOT = join(HERE, '..', '..'); // viljetech-platform-backend/
const REPO_ROOT = join(BE_ROOT, '..');
const FE_ROOT = join(REPO_ROOT, 'viljetech-platform-frontend');

/** `KEY: 'value',` inside an object literal — the shape both BE catalogs use. */
const objectValues = (src: string, exportName: string): Set<string> => {
    const block = new RegExp(`export const ${exportName} = \\{([\\s\\S]*?)\\n\\} as const`).exec(src);
    if (!block) return new Set();
    // Anchored on a KEY, so string literals appearing in comments are ignored —
    // `audit.ts` prose contains `'system'` and `'failed'`, which an unanchored
    // match would silently add to the catalog.
    return new Set([...block[1].matchAll(/^\s+[A-Z][A-Z_0-9]*:\s*'([^']+)'/gm)].map((m) => m[1]));
};

/** `'value',` inside an array literal — the shape `audit-catalog.ts` uses. */
const arrayValues = (src: string, exportName: string): Set<string> => {
    const block = new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\n\\]`).exec(src);
    if (!block) return new Set();
    return new Set([...block[1].matchAll(/^\s+'([^']+)'/gm)].map((m) => m[1]));
};

interface MirrorConfig {
    /** Label used in failure output. */
    name: string;
    bePath: string;
    fePath: string;
    beExport: string;
    feExport: string;
    /** How the FE catalog is written — object literal or array literal. */
    feShape: 'object' | 'array';
    /**
     * Backend-only entries that are correct as they are, each with the file
     * that uses it. Only `error-codes` legitimately has any.
     */
    beOnlyAllowed: readonly string[];
}

const MIRRORS: readonly MirrorConfig[] = [
    {
        name: 'permissions',
        bePath: join(BE_ROOT, 'src/constants/permissions.ts'),
        fePath: join(FE_ROOT, 'src/lib/permissions.ts'),
        beExport: 'PERMISSIONS',
        feExport: 'PERMISSIONS',
        feShape: 'object',
        beOnlyAllowed: [],
    },
    {
        name: 'error-codes',
        bePath: join(BE_ROOT, 'src/constants/error-codes.ts'),
        fePath: join(FE_ROOT, 'src/lib/error-codes.ts'),
        beExport: 'ERROR_CODES',
        feExport: 'ERROR_CODES',
        feShape: 'object',
        beOnlyAllowed: [
            // Log codes — written to the logger, never thrown, never sent to a client.
            'AUDIT_WRITE_FAILED', //            services/audit.service.ts
            'NOTIFICATION_DISPATCH_FAILED', //  services/notification-dispatcher.service.ts
            'PUSH_DISPATCH_FAILED', //          utils/push.ts
            'SLACK_INTERACTIVE_REJECTED', //    middlewares/slack-webhook.middleware.ts
            // Persisted on a `job_runs` row as `error_code`, not returned over HTTP.
            'JOB_RUN_FAILED', //                jobs/stuck-job-sweeper.job.ts
        ],
    },
    {
        name: 'audit-catalog (actions)',
        bePath: join(BE_ROOT, 'src/constants/audit.ts'),
        fePath: join(FE_ROOT, 'src/lib/audit-catalog.ts'),
        beExport: 'AUDIT_ACTIONS',
        feExport: 'AUDIT_ACTIONS',
        feShape: 'array',
        beOnlyAllowed: [],
    },
    {
        name: 'audit-catalog (target kinds)',
        bePath: join(BE_ROOT, 'src/constants/audit.ts'),
        fePath: join(FE_ROOT, 'src/lib/audit-catalog.ts'),
        beExport: 'AUDIT_TARGET_KINDS',
        feExport: 'AUDIT_TARGET_KINDS',
        feShape: 'array',
        beOnlyAllowed: [],
    },
];

const read = (p: string): string => {
    const src = readFileSync(p, 'utf8');
    // Guard against a path change turning this into a no-op: an empty read
    // would report every entry as drift, or — if the assertion were ever
    // inverted — silently pass everything.
    expect(src.length).toBeGreaterThan(0);
    return src;
};

describe('FE↔BE mirror coverage', () => {
    it.each(MIRRORS.map((m) => [m.name, m] as const))('%s — no entries stale in the frontend', (_name, mirror) => {
        const be = objectValues(read(mirror.bePath), mirror.beExport);
        const feSrc = read(mirror.fePath);
        const fe =
            mirror.feShape === 'array' ? arrayValues(feSrc, mirror.feExport) : objectValues(feSrc, mirror.feExport);

        expect(be.size, `extracted nothing from ${mirror.bePath} — check the export name`).toBeGreaterThan(0);
        expect(fe.size, `extracted nothing from ${mirror.fePath} — check the export name`).toBeGreaterThan(0);

        const stale = [...fe].filter((v) => !be.has(v)).sort();
        expect(
            stale,
            stale.length === 0
                ? ''
                : `\n${mirror.name}: ${stale.length} entr(ies) exist in the FE mirror and not in the backend:\n` +
                      stale.map((v) => `  - ${v}`).join('\n') +
                      '\n\nUsually a rename the mirror did not follow. Delete or rename it —\n' +
                      'there is no legitimate FE-only entry in any of these catalogs.\n'
        ).toEqual([]);
    });

    it.each(MIRRORS.map((m) => [m.name, m] as const))('%s — nothing missing from the frontend', (_name, mirror) => {
        const be = objectValues(read(mirror.bePath), mirror.beExport);
        const feSrc = read(mirror.fePath);
        const fe =
            mirror.feShape === 'array' ? arrayValues(feSrc, mirror.feExport) : objectValues(feSrc, mirror.feExport);

        const missing = [...be].filter((v) => !fe.has(v) && !mirror.beOnlyAllowed.includes(v)).sort();
        expect(
            missing,
            missing.length === 0
                ? ''
                : `\n${mirror.name}: ${missing.length} backend entr(ies) are absent from the FE mirror:\n` +
                      missing.map((v) => `  - ${v}`).join('\n') +
                      '\n\nEach is ONE of:\n' +
                      '  1. drift — add it to the FE mirror (the common case);\n' +
                      "  2. internal-only — add it to this mirror's beOnlyAllowed, NAMING the\n" +
                      '     file that uses it (error codes only);\n' +
                      '  3. dead — referenced nowhere in src/, so delete it from the backend.\n\n' +
                      'See the block comment above, 03-invariants.md §22 and §24, and\n' +
                      'PENDING_WORK.md → "Coverage tests pending resolution".\n'
        ).toEqual([]);
    });

    it('the backend-only allowlists stay at their declared sizes', () => {
        // Growing an allowlist is how this test stops meaning anything. These
        // numbers are the contract; raising one needs a justifying comment
        // naming the file that uses the entry.
        const sizes = Object.fromEntries(MIRRORS.map((m) => [m.name, m.beOnlyAllowed.length]));
        expect(sizes).toEqual({
            permissions: 0,
            'error-codes': 5,
            'audit-catalog (actions)': 0,
            'audit-catalog (target kinds)': 0,
        });
    });

    it('every allowlisted entry is a real backend constant', () => {
        for (const mirror of MIRRORS) {
            if (mirror.beOnlyAllowed.length === 0) continue;
            const be = objectValues(read(mirror.bePath), mirror.beExport);
            for (const entry of mirror.beOnlyAllowed) {
                expect([...be], `${mirror.name}: allowlisted "${entry}" is not in the backend catalog`).toContain(
                    entry
                );
            }
        }
    });
});

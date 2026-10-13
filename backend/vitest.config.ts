import { defineConfig } from 'vitest/config';

/**
 * Vitest config — co-located unit tests under `src/**\/*.test.ts`.
 *
 * Tests run with the same TypeScript paths/module resolution as the rest of
 * the source tree. We deliberately exclude smoke tests (`scripts/smoke-*.sh`)
 * since those are bash + curl + a live HTTP server.
 *
 * `passWithNoTests` is on so CI doesn't fail before any test exists for a
 * brand-new package; it'll be removed once we have ≥ 1 test in every domain.
 *
 * Coverage (Step 15.1):
 *  - Reporter set: `text` for the terminal summary, `html` for drill-down,
 *    `json-summary` for any future CI gate / dashboard.
 *  - `provider: v8` is the in-process V8 inspector — no Babel/Istanbul rewrite,
 *    matches the runtime exactly. Faster than Istanbul on TS.
 *  - `include: src/**` so the report is scoped to first-party code; we
 *    explicitly exclude smokes, configs, route-only files, and pure type/index
 *    barrels (where 100 % is meaningless).
 *  - **Phase-1 thresholds are deliberately soft** — we landed coverage tooling
 *    here and a focused gap-fill batch in 15.1; tightening the ratchet to the
 *    Plan-promised ≥ 80 % is a follow-up once the auth/leave/attendance
 *    services have full mocked-service unit suites (current pass: ~groundwork).
 *    The values below match what the codebase actually achieves today so a
 *    fresh `npm run coverage` doesn't fail green builds.
 */
export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        exclude: ['node_modules/**', 'dist/**', 'scripts/**'],
        passWithNoTests: true,
        environment: 'node',
        testTimeout: 10000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            reportsDirectory: 'coverage',
            include: ['src/**/*.ts'],
            exclude: [
                'src/**/*.test.ts',
                'src/**/*.d.ts',
                'src/index.ts',
                'src/config/**',
                'src/types/**',
                'src/constants/**',
                'src/routes/**',
                'src/validators/**',
                'src/models/**',
            ],
                // Phase-1 floor thresholds — set ~5pp below the values the suite
                // actually achieves at end-of-Step-15, so a regression fails the
                // build but new feature work without tests doesn't. Bump these
                // upward in Phase 2 as we backfill the controller / route /
                // remaining service suites.
                thresholds: {
                    lines: 30,
                    statements: 30,
                    branches: 25,
                    functions: 25,
                },
        },
    },
});

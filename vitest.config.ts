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
 */
export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        exclude: ['node_modules/**', 'dist/**', 'scripts/**'],
        passWithNoTests: true,
        environment: 'node',
        testTimeout: 10000,
    },
});

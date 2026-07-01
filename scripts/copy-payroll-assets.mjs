#!/usr/bin/env node
/**
 * Post-build step: `tsc` only emits compiled `.ts` -> `.js`, it does not copy
 * non-TS assets. The payroll PDF renderer reads its logo/stamp/signature/fonts
 * from `src/assets/payroll/**` at runtime via a path relative to `dist/`, so a
 * production build silently renders those images blank unless we copy the
 * asset tree alongside the compiled output. Mirrors `src/assets` -> `dist/assets`.
 */
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const srcAssets = path.join(rootDir, 'src', 'assets');
const distAssets = path.join(rootDir, 'dist', 'assets');

if (!existsSync(srcAssets)) {
    console.log('[copy-payroll-assets] no src/assets directory found, skipping.');
    process.exit(0);
}

cpSync(srcAssets, distAssets, { recursive: true });
console.log(`[copy-payroll-assets] copied ${srcAssets} -> ${distAssets}`);

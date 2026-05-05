import { generatePdfWithPdfkit } from './pdfkit-generator.js';
import { generatePdfWithPdfmake } from './pdfmake-generator.js';
import { generatePdfWithPuppeteer } from './puppeteer-generator.js';
import { DEFAULT_PDF_ENGINE, PDF_ENGINES, type PdfEngine, type PdfGenerator } from './types.js';

/**
 * PDF generator factory (Step 30 — pluggable engines).
 *
 * Selection precedence (highest first):
 *   1. The explicit `engine` argument (used by tests + the worker
 *      when the request body carries an override).
 *   2. `process.env.PDF_ENGINE` if it's a valid `PdfEngine` value.
 *   3. `DEFAULT_PDF_ENGINE` (`pdfkit`) — works out of the box on any
 *      Node deploy.
 *
 * Unknown engine values fall through to the default and emit a
 * one-time warn so a typo in env doesn't silently swap to a
 * different backend.
 *
 * Note: this is one of the few env reads that intentionally happens
 * late (per-request, not at boot). PDF_ENGINE is fully optional —
 * unset / malformed is fine (default kicks in) — so there's no boot-
 * time validation to centralise. Late-read also keeps the test-time
 * env-mutation pattern (`process.env.PDF_ENGINE = 'pdfmake'`) working
 * without `vi.resetModules`. See `BACKEND_AUDIT.md` P3-19.
 */

const GENERATORS: Record<PdfEngine, PdfGenerator> = {
    pdfkit: generatePdfWithPdfkit,
    pdfmake: generatePdfWithPdfmake,
    puppeteer: generatePdfWithPuppeteer,
};

export const isPdfEngine = (value: string): value is PdfEngine => (PDF_ENGINES as readonly string[]).includes(value);

const envEngine = (): PdfEngine | null => {
    const raw = process.env.PDF_ENGINE;
    if (!raw) return null;
    if (isPdfEngine(raw)) return raw;
    return null;
};

export const resolvePdfEngine = (override?: PdfEngine): PdfEngine => {
    if (override && isPdfEngine(override)) return override;
    return envEngine() ?? DEFAULT_PDF_ENGINE;
};

export const getPdfGenerator = (override?: PdfEngine): PdfGenerator => GENERATORS[resolvePdfEngine(override)];

export { PDF_ENGINES, DEFAULT_PDF_ENGINE, type PdfEngine, type PdfGenerator } from './types.js';

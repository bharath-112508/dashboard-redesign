import type { TabularReport } from './tabular.js';

/**
 * PDF generator (Step 30 — DEFERRED).
 *
 * Build_Decisions §D2/§D3: Puppeteer (headless Chrome) is the recommended
 * PDF library, but it needs an always-on Container Apps deployment to
 * avoid 30s+ cold-start cost on Functions. That infra is **not yet
 * provisioned**, so this generator throws a known error string the
 * worker maps to `EXPORT_PDF_NOT_AVAILABLE` + a friendly message.
 *
 * When Container Apps lands:
 *  1. Install `puppeteer` (heavy — pulls a Chromium build)
 *  2. Replace this body with the HTML→PDF render
 *  3. Drop the EXPORT_PDF_NOT_AVAILABLE branch in the worker
 *
 * The validator deliberately accepts `pdf` so the FE can pre-build the
 * UI and the contract is forward-compatible — the failure surfaces as
 * a `failed` row, not a 400.
 */

export class PdfNotAvailableError extends Error {
    code = 'EXPORT_PDF_NOT_AVAILABLE';
    constructor() {
        super(
            'PDF export is not yet available in this build. The required Puppeteer + ' +
                'Container Apps deployment is on the Phase-3 roadmap; ' +
                'CSV and XLSX are supported today.'
        );
        this.name = 'PdfNotAvailableError';
    }
}

// `_table` is intentionally unused — the stub never produces output. The
// signature mirrors the other generators so the worker dispatch table
// stays homogeneous when the real generator lands.
export const generatePdf = async (_table: TabularReport): Promise<Buffer> => {
    throw new PdfNotAvailableError();
};

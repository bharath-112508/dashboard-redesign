import { getPdfGenerator, resolvePdfEngine } from './pdf-generators/index.js';
import type { TabularReport } from './tabular.js';

/**
 * PDF entrypoint — public surface used by the report-export worker.
 *
 * Implementation now ships (Phase-4 cleanup pass): we delegate to the
 * pluggable generator factory in `pdf-generators/`. Three engines are
 * available out of the box; selection happens via the `PDF_ENGINE` env
 * var with `pdfkit` as the default. See `pdf-generators/types.ts` for
 * trade-offs.
 *
 * The legacy `PdfNotAvailableError` class is retained so the worker /
 * tests can still surface a clean `EXPORT_PDF_NOT_AVAILABLE` if a
 * future config selects an engine whose backing package is missing
 * (currently only puppeteer, which is opt-in to keep the install
 * lean). The constructor signature was widened so the puppeteer
 * loader's "install puppeteer to enable" hint can ride through to
 * the FE-visible error message.
 */

export class PdfNotAvailableError extends Error {
    code = 'EXPORT_PDF_NOT_AVAILABLE';
    constructor(message?: string) {
        super(message ?? 'PDF export is not yet available in this build. ' + 'CSV and XLSX are supported today.');
        this.name = 'PdfNotAvailableError';
    }
}

export const generatePdf = async (table: TabularReport): Promise<Buffer> => {
    const generator = getPdfGenerator();
    try {
        return await generator(table);
    } catch (err) {
        // The puppeteer engine throws a structured "package not
        // installed" error when selected without `puppeteer` on disk.
        // Surface it as `EXPORT_PDF_NOT_AVAILABLE` so the worker
        // writes the same friendly failed-export row the legacy stub
        // did. We also include the engine name so the operator sees
        // which selection caused it.
        if (err instanceof Error && /puppeteer/i.test(err.message)) {
            throw new PdfNotAvailableError(`PDF engine "${resolvePdfEngine()}" is unavailable: ${err.message}`);
        }
        throw err;
    }
};

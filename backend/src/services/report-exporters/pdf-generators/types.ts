import type { TabularReport } from '../tabular.js';

/**
 * PDF generator strategy interface.
 *
 * Every backend (`pdfkit`, `pdfmake`, `puppeteer`, future `pdf-lib`)
 * implements this single async function — input is the same `TabularReport`
 * IR every other format generator consumes; output is a Buffer the
 * worker uploads to Blob storage.
 *
 * Generators MUST NOT keep state between calls — the worker may run
 * multiple exports concurrently and a stateful generator would race.
 */
export type PdfGenerator = (table: TabularReport) => Promise<Buffer>;

/**
 * Engine identifier — selectable via env (`PDF_ENGINE`) or settings.
 *
 *  - `pdfkit`     — programmatic, pure JS, no external runtime. Default.
 *                   Smallest dependency footprint (~3 MB), works in any
 *                   Node deploy. Tabular layout via column-iterating
 *                   primitives.
 *  - `pdfmake`    — declarative JSON document definition with built-in
 *                   table primitives. Pure JS (~1 MB), ships VFS fonts.
 *                   Cleaner table layout out of the box than pdfkit but
 *                   slightly heavier deserialisation cost.
 *  - `puppeteer`  — HTML → PDF via headless Chromium. Pixel-perfect
 *                   typography and CSS support, but pulls a ~200 MB
 *                   Chromium binary and needs an always-on host
 *                   (Container Apps, not Functions; see
 *                   Build_Decisions §D2/§D3). Loaded via dynamic import
 *                   so the rest of the system can run without it
 *                   installed; the worker degrades gracefully when
 *                   selected-but-missing.
 */
export const PDF_ENGINES = ['pdfkit', 'pdfmake', 'puppeteer'] as const;
export type PdfEngine = (typeof PDF_ENGINES)[number];

export const DEFAULT_PDF_ENGINE: PdfEngine = 'pdfkit';

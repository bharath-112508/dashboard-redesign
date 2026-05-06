import { createRequire } from 'node:module';

// pdfmake (and its bundled vfs_fonts) are CJS-only and ship no TS types,
// so a regular ESM `import` either resolves to the namespace or fails the
// `tsx` ESM runtime. Re-introduce `require` via `createRequire` — same
// runtime semantics as Node's classic loader, scoped to this module.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfmake = require('pdfmake');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vfsFonts = require('pdfmake/build/vfs_fonts.js') as Record<string, string>;

import type { PdfGenerator } from './types.js';
import type { TabularReport } from '../tabular.js';

/**
 * pdfmake-based PDF generator.
 *
 * Declarative document definition — instead of driving the cursor by
 * hand (pdfkit) we describe the page as a JSON tree and pdfmake
 * paginates / wraps / aligns automatically. The built-in `table`
 * widget gives us proper column borders + header repeat-on-page-break
 * for free; pdfkit needed manual implementation of both.
 *
 * Trade-offs vs. pdfkit:
 *  - PRO: cleaner table layout (borders, header repeat, auto-wrap),
 *    declarative source is easier to maintain, ships Roboto fonts in
 *    its VFS so no need to embed TTFs ourselves.
 *  - CON: heavier deserialisation overhead per render; column-width
 *    `auto` is slower than pdfkit's manual widths on huge tables.
 *
 * pdfmake 0.3.x changed the API — it no longer exports a constructor.
 * The module IS the singleton; you call `addFonts(...)` once,
 * load the VFS into `virtualfs.writeFileSync(...)`, then call
 * `createPdf(def).getBuffer(cb)` per render. Our setup happens
 * lazily on the first call (`ensureSetup()` is idempotent).
 *
 * Like pdfkit, the whole document is buffered to memory before
 * resolving — fine for the row-cap-bounded reports we ship today.
 */

interface PdfmakeApi {
    addFonts(fonts: Record<string, Record<string, string>>): void;
    virtualfs: {
        writeFileSync(filename: string, content: Buffer): void;
        existsSync(filename: string): boolean;
    };
    createPdf(definition: Record<string, unknown>): {
        // pdfmake 0.3.x switched from the historical `getBuffer(cb)`
        // callback to a Promise return. Confirmed via OutputDocument.js
        // (`getBuffer()` returns `this.bufferPromise`). Older docs
        // showing the callback form are pre-0.3.
        getBuffer(): Promise<Buffer>;
    };
}

const pm = pdfmake as PdfmakeApi;

let setupComplete = false;
const ensureSetup = (): void => {
    if (setupComplete) return;
    pm.addFonts({
        Roboto: {
            normal: 'Roboto-Regular.ttf',
            bold: 'Roboto-Medium.ttf',
            italics: 'Roboto-Italic.ttf',
            bolditalics: 'Roboto-MediumItalic.ttf',
        },
    });
    // The bundled `vfs_fonts.js` is a `{filename: base64}` map. pdfkit
    // (which pdfmake wraps) reads via `virtualfs.readFileSync` which
    // wants a Buffer. We seed the VFS once.
    for (const [name, b64] of Object.entries(vfsFonts)) {
        pm.virtualfs.writeFileSync(name, Buffer.from(b64, 'base64'));
    }
    setupComplete = true;
};

const buildDocDefinition = (table: TabularReport): Record<string, unknown> => {
    const summaryBody =
        table.summary.length > 0
            ? table.summary.map((s) => [
                  { text: s.label, bold: true, fontSize: 10 },
                  { text: s.value, fontSize: 10 },
              ])
            : null;

    const tableBody: unknown[][] = [];
    if (table.columns.length > 0) {
        // Header row — bold + grey fill. pdfmake's `headerRows: 1`
        // automatically repeats this row at the top of every page.
        tableBody.push(
            table.columns.map((c) => ({
                text: c.label,
                bold: true,
                fontSize: 9,
                fillColor: '#f0f0f0',
            }))
        );
        for (const row of table.rows) {
            tableBody.push(
                table.columns.map((c) => {
                    const cell = row[c.key];
                    return {
                        text: cell === null || cell === undefined ? '' : String(cell),
                        fontSize: 9,
                    };
                })
            );
        }
    }

    return {
        pageSize: 'A4',
        pageOrientation: 'landscape',
        pageMargins: [40, 40, 40, 40],
        defaultStyle: { font: 'Roboto' },
        info: { title: table.title },
        content: [
            { text: table.title, fontSize: 18, bold: true, marginBottom: 8 },
            ...(summaryBody
                ? [
                      { text: 'Summary', fontSize: 12, bold: true, marginBottom: 4 },
                      {
                          table: { widths: ['auto', '*'], body: summaryBody },
                          layout: 'noBorders',
                          marginBottom: 12,
                      },
                  ]
                : []),
            ...(tableBody.length > 0
                ? [
                      {
                          table: {
                              widths: table.columns.map(() => '*'),
                              headerRows: 1,
                              body: tableBody,
                          },
                      },
                  ]
                : [{ text: 'No rows to display.', fontSize: 10 }]),
        ],
    };
};

export const generatePdfWithPdfmake: PdfGenerator = async (table) => {
    ensureSetup();
    const definition = buildDocDefinition(table);
    return pm.createPdf(definition).getBuffer();
};

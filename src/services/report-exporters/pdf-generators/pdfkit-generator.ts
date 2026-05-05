import PDFDocument from 'pdfkit';

import type { PdfGenerator } from './types.js';
import type { TabularColumn, TabularReport } from '../tabular.js';

/**
 * pdfkit-based PDF generator (default).
 *
 * Pure-JS, no external runtime. Programmatic API: we drive the
 * cursor manually for the title block, the summary key/value list,
 * and the column-aligned data table. Defaults are intentionally
 * conservative — A4 landscape so wide tables (billing rows with 6+
 * columns) fit without horizontal overflow; the standard PDF font
 * `Helvetica` to avoid embedding TTFs.
 *
 * Trade-offs vs. pdfmake / puppeteer:
 *  - PRO: smallest install (~3 MB), no Chromium, stable + battle-tested
 *  - CON: every layout decision is manual — text wrapping at column
 *    boundaries, page-break detection on long tables, header repeat on
 *    page break — all done in this file. The output is purely
 *    serviceable, not pixel-perfect.
 *
 * The whole document is buffered to memory before resolving — fine
 * for the row-cap-bounded reports we ship today (≤ 1 000 rows). If a
 * future report needs to stream gigabyte-sized PDFs, consume the
 * `'data'` event directly into Blob upload instead of `Buffer.concat`.
 */

const PAGE_MARGIN = 40;
const TITLE_FONT_SIZE = 18;
const SECTION_FONT_SIZE = 12;
const TABLE_FONT_SIZE = 9;
const ROW_HEIGHT = 18;

const renderSummary = (doc: PDFKit.PDFDocument, summary: TabularReport['summary'], pageWidth: number): void => {
    if (summary.length === 0) return;
    doc.fontSize(SECTION_FONT_SIZE).font('Helvetica-Bold').text('Summary', { underline: false });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    for (const item of summary) {
        // `key: value` two-column line. Width budget = pageWidth (the
        // text just word-wraps at the right margin if a value blows the
        // line — uncommon for our summary fields).
        doc.text(`${item.label}: ${item.value}`, {
            width: pageWidth,
            lineGap: 2,
        });
    }
    doc.moveDown(0.5);
};

/**
 * Compute equal-width columns. Real layouts would weight by column
 * type (numbers narrower than free text), but uniform widths are good
 * enough for a v1 PDF — the worker output is for record-keeping, not
 * presentation.
 */
const computeColumnWidths = (columns: TabularColumn[], pageWidth: number): number[] => {
    if (columns.length === 0) return [];
    const w = pageWidth / columns.length;
    return columns.map(() => w);
};

const renderTableHeader = (
    doc: PDFKit.PDFDocument,
    columns: TabularColumn[],
    columnWidths: number[],
    leftEdge: number,
    y: number
): number => {
    doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE);
    let x = leftEdge;
    for (let i = 0; i < columns.length; i++) {
        doc.text(columns[i].label, x + 4, y + 4, {
            width: columnWidths[i] - 8,
            ellipsis: true,
            lineBreak: false,
        });
        x += columnWidths[i];
    }
    // Header underline.
    const headerBottom = y + ROW_HEIGHT;
    doc.moveTo(leftEdge, headerBottom)
        .lineTo(leftEdge + columnWidths.reduce((a, b) => a + b, 0), headerBottom)
        .stroke();
    return headerBottom;
};

const renderRow = (
    doc: PDFKit.PDFDocument,
    columns: TabularColumn[],
    columnWidths: number[],
    row: Record<string, unknown>,
    leftEdge: number,
    y: number
): number => {
    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    let x = leftEdge;
    for (let i = 0; i < columns.length; i++) {
        const cell = row[columns[i].key];
        const text = cell === null || cell === undefined ? '' : String(cell);
        doc.text(text, x + 4, y + 4, {
            width: columnWidths[i] - 8,
            ellipsis: true,
            lineBreak: false,
        });
        x += columnWidths[i];
    }
    return y + ROW_HEIGHT;
};

export const generatePdfWithPdfkit: PdfGenerator = (table) =>
    new Promise<Buffer>((resolve, reject) => {
        try {
            // A4 landscape so wide tables fit. `bufferPages` lets us
            // re-paginate the header on every page after the first.
            const doc = new PDFDocument({
                size: 'A4',
                layout: 'landscape',
                margin: PAGE_MARGIN,
                info: { Title: table.title },
            });

            const chunks: Buffer[] = [];
            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const pageWidth = doc.page.width - PAGE_MARGIN * 2;
            const leftEdge = PAGE_MARGIN;

            // Title.
            doc.font('Helvetica-Bold').fontSize(TITLE_FONT_SIZE).text(table.title);
            doc.moveDown(0.5);

            // Summary key/value block.
            renderSummary(doc, table.summary, pageWidth);

            // Skip the table block entirely if no rows — `summary` alone
            // is a valid output for a leave report on a year with no
            // balances, etc.
            if (table.columns.length === 0 || table.rows.length === 0) {
                doc.font('Helvetica').fontSize(10).text('No rows to display.');
                doc.end();
                return;
            }

            // Table header.
            const columnWidths = computeColumnWidths(table.columns, pageWidth);
            let y = doc.y + 4;
            y = renderTableHeader(doc, table.columns, columnWidths, leftEdge, y);

            // Table rows. Insert a page break + repeat the header when
            // the cursor approaches the bottom margin. `doc.page.height`
            // is the full sheet (incl. margins); we need to leave one
            // ROW_HEIGHT of buffer below the last row.
            const pageBottom = doc.page.height - PAGE_MARGIN - ROW_HEIGHT;
            for (const row of table.rows) {
                if (y + ROW_HEIGHT > pageBottom) {
                    doc.addPage();
                    y = PAGE_MARGIN + 4;
                    y = renderTableHeader(doc, table.columns, columnWidths, leftEdge, y);
                }
                y = renderRow(doc, table.columns, columnWidths, row, leftEdge, y);
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });

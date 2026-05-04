import ExcelJS from 'exceljs';

import type { TabularReport } from './tabular.js';

/**
 * XLSX generator (Step 30) using `exceljs`.
 *
 * Output layout mirrors the CSV but uses Excel-native styling:
 *  - Title row in **bold, 14pt**, spanning all columns
 *  - Summary block as label/value pairs (label in bold)
 *  - Blank row
 *  - Header row in bold with a light grey background
 *  - Auto-sized columns (capped at 50 chars to keep wide rows from
 *    blowing the page out)
 *
 * `exceljs.writeBuffer()` resolves to a Node Buffer-compatible object
 * (technically `ArrayBuffer`-like). We `Buffer.from(...)` it to normalize
 * for the upload helper.
 *
 * Memory: a 1 000-row report at ~10 columns is ~30 KiB on disk — well
 * within the in-memory budget for an in-process worker. If the row cap is
 * ever raised in `report.service`, switch to `WorkbookWriter` for the
 * streaming path.
 */
export const generateXlsx = async (table: TabularReport): Promise<Buffer> => {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Viljetech';
    wb.created = new Date();

    // Sheet name: cap at 31 chars (Excel's hard limit) and strip the
    // chars Excel forbids in sheet names (`*?:\/[]`).
    const sheetName = table.title.replace(/[*?:\\/[\]]/g, '').slice(0, 31) || 'Report';
    const sheet = wb.addWorksheet(sheetName, {
        views: [{ state: 'frozen', ySplit: table.summary.length + 3 }],
    });

    let cursor = 1;

    // Title.
    const titleRow = sheet.getRow(cursor);
    titleRow.getCell(1).value = table.title;
    titleRow.getCell(1).font = { bold: true, size: 14 };
    sheet.mergeCells(cursor, 1, cursor, Math.max(2, table.columns.length));
    cursor += 2;

    // Summary block.
    for (const item of table.summary) {
        const row = sheet.getRow(cursor);
        row.getCell(1).value = item.label;
        row.getCell(1).font = { bold: true };
        row.getCell(2).value = item.value;
        cursor += 1;
    }
    if (table.summary.length > 0) cursor += 1; // blank line before headers

    // Header row.
    const headerRow = sheet.getRow(cursor);
    table.columns.forEach((c, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = c.label;
        cell.font = { bold: true };
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE5E5E5' },
        };
    });
    cursor += 1;

    // Data rows.
    for (const row of table.rows) {
        const r = sheet.getRow(cursor);
        table.columns.forEach((c, i) => {
            const v = row[c.key];
            r.getCell(i + 1).value = v === undefined ? null : v;
        });
        cursor += 1;
    }

    // Column widths — width = max(header.length, longest cell.length),
    // capped at 50. exceljs measures in "character units" (one digit
    // ~= one unit at default font), close enough for our flat tables.
    table.columns.forEach((c, i) => {
        const headerLen = c.label.length;
        const dataLen = table.rows.reduce((max, row) => {
            const v = row[c.key];
            const s = v === null || v === undefined ? '' : String(v);
            return Math.max(max, s.length);
        }, 0);
        sheet.getColumn(i + 1).width = Math.min(50, Math.max(headerLen, dataLen) + 2);
    });

    const ab = await wb.xlsx.writeBuffer();
    // exceljs returns a `Buffer | ArrayBufferLike`; Buffer.from accepts both.
    return Buffer.from(ab as ArrayBuffer);
};

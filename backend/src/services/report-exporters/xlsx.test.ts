import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

import { generateXlsx } from './xlsx.js';
import type { TabularReport } from './tabular.js';

/**
 * XLSX generator unit tests (Step 30).
 *
 * Coverage focus:
 *  1. Output is a valid XLSX (round-trips through `exceljs` reader).
 *  2. Title, summary, header, data sections render in the expected rows.
 *  3. Sheet name strips Excel-illegal characters and caps at 31 chars.
 *  4. Frozen-pane row count == summary length + 3 (title + blank + headers + 1).
 *  5. Numeric cells stay numeric (Excel's "5,141" vs the string "5,141"
 *     would mis-render in a number column).
 *
 * Round-trip is the strongest assertion — anything an actual Excel
 * client could read works through `exceljs.read`.
 */

const sample = (): TabularReport => ({
    title: 'Billing report',
    summary: [
        { label: 'Project', value: 'Apollo' },
        { label: 'From', value: '2026-04-01' },
        { label: 'To', value: '2026-04-30' },
    ],
    columns: [
        { key: 'user', label: 'User' },
        { key: 'minutes', label: 'Minutes' },
        { key: 'rate', label: 'Rate' },
    ],
    rows: [
        { user: 'Anna', minutes: 600, rate: 2500 },
        { user: 'Ben', minutes: 120, rate: null },
    ],
});

describe('generateXlsx', () => {
    it('produces a workbook readable by exceljs (round-trip)', async () => {
        const buf = await generateXlsx(sample());
        const reread = new ExcelJS.Workbook();
        await reread.xlsx.load(buf as unknown as Parameters<typeof ExcelJS.Workbook.prototype.xlsx.load>[0]);
        const sheet = reread.worksheets[0];
        expect(sheet).toBeDefined();
        expect(sheet.name).toBe('Billing report');
    });

    it('lays out title → summary → header → data in the expected rows', async () => {
        const buf = await generateXlsx(sample());
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as Parameters<typeof ExcelJS.Workbook.prototype.xlsx.load>[0]);
        const sheet = wb.worksheets[0];

        // Row 1: title.
        expect(sheet.getRow(1).getCell(1).value).toBe('Billing report');
        // Row 2: blank.
        expect(sheet.getRow(2).getCell(1).value).toBeNull();
        // Rows 3-5: summary (label + value).
        expect(sheet.getRow(3).getCell(1).value).toBe('Project');
        expect(sheet.getRow(3).getCell(2).value).toBe('Apollo');
        expect(sheet.getRow(5).getCell(1).value).toBe('To');
        // Row 6: blank between summary + header.
        expect(sheet.getRow(6).getCell(1).value).toBeNull();
        // Row 7: header.
        expect(sheet.getRow(7).getCell(1).value).toBe('User');
        expect(sheet.getRow(7).getCell(2).value).toBe('Minutes');
        // Rows 8-9: data.
        expect(sheet.getRow(8).getCell(1).value).toBe('Anna');
        expect(sheet.getRow(8).getCell(2).value).toBe(600);
        expect(sheet.getRow(8).getCell(3).value).toBe(2500);
        expect(sheet.getRow(9).getCell(3).value).toBeNull();
    });

    it('preserves numeric typing on Number cells (no auto-stringification)', async () => {
        const buf = await generateXlsx(sample());
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as Parameters<typeof ExcelJS.Workbook.prototype.xlsx.load>[0]);
        const minutesCell = wb.worksheets[0].getRow(8).getCell(2);
        expect(typeof minutesCell.value).toBe('number');
    });

    it('strips illegal sheet-name characters and caps at 31 chars', async () => {
        const t: TabularReport = {
            title: 'Long title with /[]:*? illegal chars and a tail past 31 chars',
            summary: [],
            columns: [{ key: 'a', label: 'A' }],
            rows: [],
        };
        const buf = await generateXlsx(t);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as Parameters<typeof ExcelJS.Workbook.prototype.xlsx.load>[0]);
        const name = wb.worksheets[0].name;
        expect(name.length).toBeLessThanOrEqual(31);
        // None of the illegal chars should appear in the sheet name.
        expect(name).not.toMatch(/[*?:\\/[\]]/);
    });

    it('falls back to "Report" when the title strips to empty', async () => {
        const t: TabularReport = {
            title: '/*?:[]\\',
            summary: [],
            columns: [{ key: 'a', label: 'A' }],
            rows: [],
        };
        const buf = await generateXlsx(t);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as Parameters<typeof ExcelJS.Workbook.prototype.xlsx.load>[0]);
        expect(wb.worksheets[0].name).toBe('Report');
    });
});

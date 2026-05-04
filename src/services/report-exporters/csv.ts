import type { CellValue, TabularReport } from './tabular.js';

/**
 * CSV generator (Step 30).
 *
 * Inline RFC-4180 stringifier — no `csv-stringify` dep. The data shape is
 * simple flat tables with bounded cell types (string | number | null) so
 * a 30-line escaper covers it. Saves ~1 MB install + one transitive dep.
 *
 * Encoding:
 *  - UTF-8 with **BOM** (`U+FEFF`). Excel for Windows mis-detects UTF-8
 *    as Windows-1252 without it, mangling non-ASCII names. The BOM costs
 *    3 bytes and is invisible in any modern reader.
 *  - CRLF line endings (`\r\n`) per RFC 4180. Most modern parsers accept LF
 *    too, but Excel < 2011 and a few older tools still require CRLF.
 *  - Quoting rule: a cell needs quotes iff it contains `,`, `"`, `\r`, or
 *    `\n`. Numbers and nulls render unquoted ("" for null) so spreadsheets
 *    treat them as numeric.
 *
 * Layout:
 *   Title row (single cell)
 *   Blank line
 *   Summary block — one row per `{label, value}`, two cells
 *   Blank line
 *   Header row
 *   Data rows (one per `rows[i]`)
 */

const CRLF = '\r\n';
// UTF-8 BOM (U+FEFF). Stored as raw bytes so the source file itself
// stays plain ASCII — avoids tripping `no-irregular-whitespace`.
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

const cellNeedsQuoting = (s: string): boolean => /[",\r\n]/.test(s);

const escapeCell = (value: CellValue): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
        // `Number.toString()` on Infinity / NaN is the literal "Infinity" /
        // "NaN" which is not a valid CSV numeric — coerce to empty so a
        // pathological aggregation doesn't render as a string in a number
        // column.
        if (!Number.isFinite(value)) return '';
        return String(value);
    }
    const s = String(value);
    if (!cellNeedsQuoting(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
};

const renderRow = (cells: CellValue[]): string => cells.map(escapeCell).join(',');

export const generateCsv = (table: TabularReport): Buffer => {
    const lines: string[] = [];

    // Title row.
    lines.push(renderRow([table.title]));
    lines.push('');

    // Summary block.
    for (const item of table.summary) {
        lines.push(renderRow([item.label, item.value]));
    }
    if (table.summary.length > 0) lines.push('');

    // Header row + data.
    lines.push(renderRow(table.columns.map((c) => c.label)));
    for (const row of table.rows) {
        lines.push(renderRow(table.columns.map((c) => row[c.key] ?? null)));
    }

    return Buffer.concat([BOM_BYTES, Buffer.from(lines.join(CRLF) + CRLF, 'utf8')]);
};

import { describe, expect, it } from 'vitest';

import { generateCsv } from './csv.js';
import type { TabularReport } from './tabular.js';

/**
 * CSV generator unit tests (Step 30).
 *
 * Coverage focus:
 *  1. UTF-8 BOM for Excel-on-Windows compatibility.
 *  2. CRLF line endings (RFC 4180).
 *  3. Quoting rule fires only on `,`, `"`, `\r`, `\n`.
 *  4. Embedded `"` inside a quoted cell is doubled (`""`).
 *  5. Numeric cells render unquoted; null cells render empty.
 *  6. Blank line separator between summary and data sections.
 *
 * The BOM is the 3 bytes `EF BB BF` (UTF-8 encoding of U+FEFF). Tests
 * compare bytes directly or `.slice(3)` past the BOM rather than embedding
 * the literal BOM character — keeps the test file plain ASCII so
 * `no-irregular-whitespace` passes.
 */

const BOM_LENGTH = 3;

const decodeWithoutBom = (buf: Buffer): string => buf.subarray(BOM_LENGTH).toString('utf8');

const sample = (): TabularReport => ({
    title: 'Test, Report "Sample"',
    summary: [
        { label: 'Project', value: 'Apollo' },
        { label: 'From', value: '2026-04-01' },
    ],
    columns: [
        { key: 'user', label: 'User' },
        { key: 'task', label: 'Task' },
        { key: 'minutes', label: 'Minutes' },
        { key: 'rate', label: 'Rate' },
    ],
    rows: [
        { user: 'Anna "A" Smith', task: 'Build, login', minutes: 60, rate: 2500 },
        { user: 'Ben\nNewline', task: null, minutes: 0, rate: null },
    ],
});

describe('generateCsv', () => {
    it('emits a UTF-8 BOM as the first three bytes', () => {
        const buf = generateCsv(sample());
        expect(buf[0]).toBe(0xef);
        expect(buf[1]).toBe(0xbb);
        expect(buf[2]).toBe(0xbf);
    });

    it('uses CRLF as the row separator (newlines INSIDE quoted cells stay literal per RFC 4180)', () => {
        const buf = generateCsv(sample());
        const text = buf.toString('utf8');
        // Strip everything inside quotes to check only structural line endings.
        const outsideQuotes = text.replace(/"(?:[^"]|"")*"/g, '<quoted>');
        expect(outsideQuotes).toContain('\r\n');
        // After stripping quoted regions, no bare LF without preceding CR.
        const bareLf = outsideQuotes.match(/(?<!\r)\n/g);
        expect(bareLf).toBeNull();
    });

    it('quotes cells containing comma, quote, or newline; doubles inner quotes', () => {
        const buf = generateCsv(sample());
        const text = decodeWithoutBom(buf);
        const lines = text.split('\r\n');

        // Title contains both `,` and `"` → fully quoted with doubled quotes.
        expect(lines[0]).toBe('"Test, Report ""Sample"""');

        // Header row: nothing exotic, no quoting.
        const headerIdx = lines.findIndex((l) => l.startsWith('User,'));
        expect(lines[headerIdx]).toBe('User,Task,Minutes,Rate');

        // First data row: user has an embedded quote, task has a comma.
        const annaRow = lines[headerIdx + 1];
        expect(annaRow).toBe('"Anna ""A"" Smith","Build, login",60,2500');
    });

    it('renders nulls as empty cells and numbers unquoted', () => {
        const buf = generateCsv(sample());
        const text = decodeWithoutBom(buf);
        const lines = text.split('\r\n');
        const benRow = lines[lines.findIndex((l) => l.startsWith('User,')) + 2];
        // user has a `\n` so it gets quoted; task is null → empty; minutes 0 unquoted; rate null → empty.
        expect(benRow).toBe('"Ben\nNewline",,0,');
    });

    it('emits a blank line between the title block, summary block, and data', () => {
        const buf = generateCsv(sample());
        const text = decodeWithoutBom(buf);
        const lines = text.split('\r\n');
        // line 0 = title; line 1 = blank; lines 2-3 = summary; line 4 = blank; line 5 = header.
        expect(lines[1]).toBe('');
        expect(lines[4]).toBe('');
        expect(lines[5]).toBe('User,Task,Minutes,Rate');
    });

    it('handles an empty rows[] without crashing — header row only', () => {
        const empty: TabularReport = {
            title: 'Empty',
            summary: [],
            columns: [{ key: 'a', label: 'A' }],
            rows: [],
        };
        const text = decodeWithoutBom(generateCsv(empty));
        const lines = text.split('\r\n').filter((l) => l !== '');
        // Title + header only (no summary block, no data).
        expect(lines).toEqual(['Empty', 'A']);
    });

    it('coerces NaN and Infinity to empty cells (would otherwise be a stringy "NaN" in a number column)', () => {
        const t: TabularReport = {
            title: 't',
            summary: [],
            columns: [{ key: 'x', label: 'X' }],
            rows: [{ x: NaN }, { x: Infinity }],
        };
        const text = decodeWithoutBom(generateCsv(t));
        const lines = text.split('\r\n');
        const headerIdx = lines.findIndex((l) => l === 'X');
        expect(lines[headerIdx + 1]).toBe('');
        expect(lines[headerIdx + 2]).toBe('');
    });
});

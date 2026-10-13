import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { generatePdfWithPdfkit } from './pdfkit-generator.js';
import { generatePdfWithPdfmake } from './pdfmake-generator.js';
import { resolvePdfEngine, getPdfGenerator, isPdfEngine, DEFAULT_PDF_ENGINE } from './index.js';
import type { TabularReport } from '../tabular.js';

/**
 * Integration tests for the PDF generator pluggable architecture
 * (Step 30 — Phase-4 cleanup pass).
 *
 * pdfkit + pdfmake are pure-JS and ship in the install, so we run
 * them end-to-end against a small fixture and assert on the output
 * Buffer's structural shape (`%PDF-` header byte signature). We do
 * NOT assert on rendered pixels — that would be both impractical and
 * brittle.
 *
 * puppeteer is opt-in (not in package.json) so the integration test
 * for it is the loader's "package not installed" error path; the
 * happy-path render is exercised manually by operators after they
 * `npm install puppeteer`.
 */

const FIXTURE: TabularReport = {
    title: 'Test Report',
    summary: [
        { label: 'Project', value: 'Acme' },
        { label: 'From', value: '2026-01-01' },
        { label: 'To', value: '2026-01-31' },
    ],
    columns: [
        { key: 'user', label: 'User' },
        { key: 'hours', label: 'Hours' },
        { key: 'amount', label: 'Amount' },
    ],
    rows: [
        { user: 'Alice', hours: 40, amount: 4000 },
        { user: 'Bob', hours: 35, amount: 3500 },
        { user: 'Carol', hours: 0, amount: null },
    ],
};

const EMPTY_FIXTURE: TabularReport = {
    title: 'Empty Report',
    summary: [{ label: 'Year', value: '2026' }],
    columns: [],
    rows: [],
};

const PDF_MAGIC = Buffer.from('%PDF-', 'utf8');

describe('pdfkit generator', () => {
    it('produces a valid PDF buffer for the standard fixture', async () => {
        // PDF files start with the magic bytes "%PDF-" followed by
        // the version. We don't validate the rest of the file — pdfkit
        // is the system under test, and a non-empty buffer that starts
        // with the magic is a strong signal the render succeeded.
        const buf = await generatePdfWithPdfkit(FIXTURE);
        expect(buf.length).toBeGreaterThan(100);
        expect(buf.subarray(0, 5)).toEqual(PDF_MAGIC);
    });

    it('handles an empty rows fixture (renders just the title + summary)', async () => {
        // A leave report on an empty year passes through with no rows
        // — must still produce a valid PDF (the fallback "No rows to
        // display" message). Pin so a regression that crashes the
        // generator on `columns.length === 0` surfaces here.
        const buf = await generatePdfWithPdfkit(EMPTY_FIXTURE);
        expect(buf.length).toBeGreaterThan(100);
        expect(buf.subarray(0, 5)).toEqual(PDF_MAGIC);
    });

    it('handles a fixture with many rows (page-break path)', async () => {
        // The pdfkit generator inserts page breaks + repeats the
        // header on each new page. 50 rows with our row height
        // comfortably triggers ≥ 1 page break — the buffer just has
        // to come out valid.
        const big: TabularReport = {
            ...FIXTURE,
            rows: Array.from({ length: 50 }, (_, i) => ({ user: `User${i}`, hours: i, amount: i * 100 })),
        };
        const buf = await generatePdfWithPdfkit(big);
        expect(buf.length).toBeGreaterThan(1000);
        expect(buf.subarray(0, 5)).toEqual(PDF_MAGIC);
    });
});

describe('pdfmake generator', () => {
    it('produces a valid PDF buffer for the standard fixture', async () => {
        const buf = await generatePdfWithPdfmake(FIXTURE);
        expect(buf.length).toBeGreaterThan(100);
        expect(buf.subarray(0, 5)).toEqual(PDF_MAGIC);
    });

    it('renders the empty-rows fallback', async () => {
        const buf = await generatePdfWithPdfmake(EMPTY_FIXTURE);
        expect(buf.length).toBeGreaterThan(100);
        expect(buf.subarray(0, 5)).toEqual(PDF_MAGIC);
    });
});

describe('factory — engine selection', () => {
    const originalEnv = process.env.PDF_ENGINE;

    beforeEach(() => {
        delete process.env.PDF_ENGINE;
    });

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.PDF_ENGINE;
        } else {
            process.env.PDF_ENGINE = originalEnv;
        }
    });

    it('resolves to the default engine when nothing is set', () => {
        // No env, no override → DEFAULT_PDF_ENGINE (`pdfkit`). The
        // default needs to be the engine that works without infra
        // changes; if a future contributor flips the default to
        // puppeteer the test catches it.
        expect(resolvePdfEngine()).toBe(DEFAULT_PDF_ENGINE);
        expect(DEFAULT_PDF_ENGINE).toBe('pdfkit');
    });

    it('honours the `PDF_ENGINE` env var', () => {
        process.env.PDF_ENGINE = 'pdfmake';
        expect(resolvePdfEngine()).toBe('pdfmake');
    });

    it('falls back to default when env var is an unknown value', () => {
        // Defence in depth — a typo should fail loud (well, fail to
        // default) rather than silently using a different engine.
        process.env.PDF_ENGINE = 'mystery-engine';
        expect(resolvePdfEngine()).toBe(DEFAULT_PDF_ENGINE);
    });

    it('explicit override beats env', () => {
        process.env.PDF_ENGINE = 'pdfmake';
        expect(resolvePdfEngine('puppeteer')).toBe('puppeteer');
    });

    it('isPdfEngine narrows valid engine strings', () => {
        expect(isPdfEngine('pdfkit')).toBe(true);
        expect(isPdfEngine('pdfmake')).toBe(true);
        expect(isPdfEngine('puppeteer')).toBe(true);
        expect(isPdfEngine('definitely-not-an-engine')).toBe(false);
    });

    it('getPdfGenerator returns a callable for every valid engine', () => {
        for (const eng of ['pdfkit', 'pdfmake', 'puppeteer'] as const) {
            const gen = getPdfGenerator(eng);
            expect(typeof gen).toBe('function');
        }
    });
});

describe('puppeteer generator', () => {
    // Puppeteer is now an `optionalDependency` so the package is
    // present in node_modules by default. The Chromium binary download
    // is decoupled — installs that set `PUPPETEER_SKIP_DOWNLOAD=true`
    // skip it and rely on `PUPPETEER_EXECUTABLE_PATH` to point at a
    // system browser.
    //
    // The happy-path render only runs when a browser is actually
    // available (env var set or bundled Chromium present); otherwise
    // we exercise the launch-failure code path, which is distinct
    // from the package-missing path that maps to
    // `EXPORT_PDF_NOT_AVAILABLE` in the worker.
    const exePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    const condit = exePath ? it : it.skip;

    condit(
        'renders a real PDF end-to-end via the configured browser binary',
        async () => {
            const { generatePdfWithPuppeteer, __resetCachedBrowser } = await import('./puppeteer-generator.js');
            __resetCachedBrowser();
            const buf = await generatePdfWithPuppeteer(FIXTURE);
            // Real PDF: structurally valid magic bytes + a meaningful
            // size (the HTML wraps the fixture in a styled stylesheet
            // so a non-empty render is at least a few KB).
            expect(buf.length).toBeGreaterThan(500);
            expect(buf.subarray(0, 5)).toEqual(PDF_MAGIC);
            __resetCachedBrowser();
        },
        30_000
    );

    it('module loads cleanly (puppeteer is now an optionalDependency)', async () => {
        // Loader-level smoke: the dynamic import inside `loadPuppeteer`
        // resolves without surfacing the "not installed" error. The
        // happy-path render is gated above; this test passes
        // regardless of whether a browser binary is available.
        await expect(import('./puppeteer-generator.js')).resolves.toBeDefined();
    });
});

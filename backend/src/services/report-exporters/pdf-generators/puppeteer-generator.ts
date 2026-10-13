import { escapeHtml as escapeXml } from '../../../utils/mailer.js';

import type { PdfGenerator } from './types.js';
import type { TabularReport } from '../tabular.js';

/**
 * Puppeteer-based PDF generator (HTML → PDF via headless Chromium).
 *
 * Highest-fidelity output of the three engines — full CSS support,
 * proper typography, automatic table layout. Cost: a ~200 MB
 * Chromium binary and an always-on host (Container Apps; Functions
 * suffer 30s+ cold-start cost — see Build_Decisions §D2/§D3).
 *
 * Puppeteer is **NOT** in `package.json` by default to keep the
 * baseline install lean. To enable:
 *
 *   1. `npm install --save puppeteer` in the deploy environment.
 *   2. Set `PDF_ENGINE=puppeteer` (env) or
 *      `system_settings.exports.pdf_engine = 'puppeteer'`.
 *
 * If selected without being installed, the dynamic import below
 * fails and the worker surfaces `EXPORT_PDF_NOT_AVAILABLE` with a
 * message pointing the operator at the install step. The other
 * engines (pdfkit, pdfmake) keep working regardless.
 */

const buildHtml = (table: TabularReport): string => {
    const summaryRows = table.summary
        .map((s) => `<tr><th>${escapeXml(s.label)}</th><td>${escapeXml(s.value)}</td></tr>`)
        .join('');

    const headerCells = table.columns.map((c) => `<th>${escapeXml(c.label)}</th>`).join('');
    const bodyRows = table.rows
        .map(
            (r) =>
                `<tr>${table.columns
                    .map((c) => {
                        const v = r[c.key];
                        return `<td>${escapeXml(v === null || v === undefined ? '' : String(v))}</td>`;
                    })
                    .join('')}</tr>`
        )
        .join('');

    const tableHtml =
        table.columns.length > 0 && table.rows.length > 0
            ? `<table class="data"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
            : '<p class="empty">No rows to display.</p>';

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeXml(table.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; }
  h1 { font-size: 18pt; margin: 0 0 12pt 0; }
  h2 { font-size: 12pt; margin: 12pt 0 4pt 0; }
  table.summary { border-collapse: collapse; margin-bottom: 14pt; }
  table.summary th { text-align: left; padding: 2pt 12pt 2pt 0; font-weight: 600; vertical-align: top; }
  table.summary td { padding: 2pt 0; }
  table.data { border-collapse: collapse; width: 100%; font-size: 9pt; }
  table.data th { background: #f0f0f0; padding: 6pt 8pt; text-align: left; border: 0.5pt solid #cccccc; }
  table.data td { padding: 4pt 8pt; border: 0.5pt solid #e5e5e5; }
  table.data thead { display: table-header-group; }
  p.empty { font-size: 10pt; color: #666666; }
</style>
</head>
<body>
  <h1>${escapeXml(table.title)}</h1>
  ${table.summary.length > 0 ? `<h2>Summary</h2><table class="summary">${summaryRows}</table>` : ''}
  ${tableHtml}
</body>
</html>`;
};

/**
 * Lazy puppeteer loader. The package isn't a regular dep; we
 * `import()` it on first use and surface a structured error if it's
 * not installed.
 */
const loadPuppeteer = async (): Promise<unknown> => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await import(/* webpackIgnore: true */ 'puppeteer' as any)) as unknown;
    } catch (err) {
        throw new Error(
            'Puppeteer engine selected but `puppeteer` is not installed. ' +
                'Run `npm install puppeteer` (downloads ~200 MB Chromium) and redeploy. ' +
                `Original error: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
        );
    }
};

/**
 * Browser launch + reuse. Puppeteer's startup cost is high enough
 * that we cache one browser per process. The worker is single-
 * threaded per Node process so concurrent renders share the
 * browser; each render uses its own page (which is cheap to create
 * + tear down).
 *
 * Re-entrancy: the cache is a Promise so concurrent `loadPuppeteer`
 * callers share one launch.
 */
let cachedBrowser: Promise<unknown> | null = null;

const getBrowser = async (): Promise<unknown> => {
    if (cachedBrowser) return cachedBrowser;
    cachedBrowser = (async () => {
        const puppeteer = (await loadPuppeteer()) as {
            launch: (opts: Record<string, unknown>) => Promise<unknown>;
        };
        // `PUPPETEER_EXECUTABLE_PATH` (Puppeteer's own env var) lets a
        // deploy point at a system Chrome / Chromium instead of
        // downloading the bundled one — useful when puppeteer is
        // installed via `PUPPETEER_SKIP_DOWNLOAD=true` (avoids the
        // ~200 MB Chromium download in CI / Docker layers) and the
        // host already has a browser binary. Puppeteer reads it
        // automatically when the option is omitted; we explicitly
        // forward it so a future override (settings UI, per-export
        // config) has one place to plumb through. Read late (not via
        // server.config.ts) since this is a fully-optional env with
        // no boot-time validation to gain — see BACKEND_AUDIT.md
        // P3-19 for the rationale.
        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        const launchOpts: Record<string, unknown> = {
            headless: true,
            // `--no-sandbox` is required when running as root in
            // containers; harmless on macOS / dev. `--disable-dev-shm`
            // dodges the cgroup-default 64 MB /dev/shm too-small
            // problem inside Docker.
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        };
        if (executablePath) launchOpts.executablePath = executablePath;
        return puppeteer.launch(launchOpts);
    })();
    try {
        return await cachedBrowser;
    } catch (err) {
        cachedBrowser = null; // allow retry on next call
        throw err;
    }
};

interface PuppeteerPage {
    setContent(html: string, opts: Record<string, unknown>): Promise<void>;
    // Puppeteer 22+ returns `Uint8Array`; older versions returned a
    // Node `Buffer`. Both satisfy the binary-data shape we need; the
    // generator coerces to Buffer below so callers see the same type.
    pdf(opts: Record<string, unknown>): Promise<Uint8Array | Buffer>;
    close(): Promise<void>;
}

interface PuppeteerBrowser {
    newPage(): Promise<PuppeteerPage>;
    close(): Promise<void>;
}

export const generatePdfWithPuppeteer: PdfGenerator = async (table) => {
    const browser = (await getBrowser()) as PuppeteerBrowser;
    const page = await browser.newPage();
    try {
        const html = buildHtml(table);
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const result = await page.pdf({
            format: 'A4',
            landscape: true,
            margin: { top: '40px', bottom: '40px', left: '40px', right: '40px' },
            printBackground: true,
        });
        // Coerce to Buffer — Puppeteer 22+ returns Uint8Array. The
        // worker upload path expects Buffer; `Buffer.from(typedArray)`
        // is a zero-copy cast (re-uses the underlying ArrayBuffer)
        // when the input is already a Buffer, and a single allocation
        // when it's a plain Uint8Array.
        return Buffer.isBuffer(result) ? result : Buffer.from(result);
    } finally {
        await page.close();
    }
};

/**
 * Test-only hook to clear the cached browser between runs (so a
 * unit test mocking the launcher doesn't carry a stub across cases).
 */
export const __resetCachedBrowser = (): void => {
    cachedBrowser = null;
};

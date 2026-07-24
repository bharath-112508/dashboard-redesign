import type { PayrollSettings } from '../models/system-settings.model.js';

/**
 * Invoice PDF template — Phase 1 "Client Engagements & Invoicing" follow-up
 * (invoice PDF download). Pure HTML string builder, deliberately kept
 * separate from the Chromium render call (`invoice-pdf.service.ts`) so it's
 * unit-testable without a headless browser — mirrors the split already used
 * for payroll (`services/payroll/payslip-template.ts` builds HTML,
 * `services/payroll/pdf.service.ts` rasterises it).
 *
 * The invoice is an immutable snapshot once persisted (see
 * `models/invoice.model.ts`), so re-rendering the same invoice id always
 * produces byte-identical HTML — no need to persist the PDF itself.
 */

// ─── Input shapes ──────────────────────────────────────────────────────────
//
// Deliberately narrow structural types (not `InvoiceDocument`) — the caller
// passes the plain JSON returned by `invoice.service.ts#getInvoice`, and
// tests can build fixtures without touching Mongoose.

export interface InvoicePdfLineItem {
    kind: string;
    description: string;
    quantity_minutes: number | null;
    rate: number | null;
    amount: number;
}

export interface InvoicePdfInvoice {
    number: string;
    status: string;
    currency: string;
    period_start: string;
    period_end: string;
    issue_date: string | null;
    due_date: string | null;
    line_items: InvoicePdfLineItem[];
    subtotal: number;
    tax_rate: number;
    tax_label: string;
    tax_amount: number;
    total: number;
    notes: string;
}

export interface InvoicePdfCompany {
    name: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const escapeHtml = (s: unknown): string =>
    String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
    );

/** `-` for empty/whitespace-only strings so the layout never shows a blank cell. */
const field = (s: unknown): string => {
    const str = String(s ?? '').trim();
    return str === '' ? '—' : escapeHtml(str);
};

/** Server-side money formatting via `Intl.NumberFormat` — never hardcode a symbol. */
const formatMoney = (amount: number, currency: string): string => {
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency || 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(Number.isFinite(amount) ? amount : 0);
    } catch {
        // Unrecognised ISO code (shouldn't happen — `currency` is validated
        // at the model layer — but this is a rendering path, not a place to
        // throw over a formatting nicety). Escape it: it's user-influenced
        // data reaching this fallback only if it bypassed validation
        // upstream (e.g. a direct DB write), and every other user string in
        // this template is escaped — this fallback shouldn't be the one
        // exception that lets HTML metacharacters through.
        return `${escapeHtml(currency)} ${(amount || 0).toFixed(2)}`;
    }
};

const formatDate = (isoDate: string | null): string => {
    if (!isoDate) return '—';
    const d = new Date(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return escapeHtml(isoDate);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

const formatHours = (minutes: number | null): string => (minutes == null ? '—' : (minutes / 60).toFixed(2));

const STATUS_LABEL: Record<string, string> = {
    draft: 'Draft',
    sent: 'Sent',
    paid: 'Paid',
    void: 'Void',
};

// ─── Template ───────────────────────────────────────────────────────────────

export function buildInvoiceHtml(
    invoice: InvoicePdfInvoice,
    company: InvoicePdfCompany,
    settings: PayrollSettings
): string {
    const currency = invoice.currency || 'USD';
    const lines = invoice.line_items ?? [];
    const statusLabel = STATUS_LABEL[invoice.status] ?? escapeHtml(invoice.status);

    const lineRows = lines
        .map(
            (l) => `<tr>
              <td>${escapeHtml(l.description)}</td>
              <td class="num">${formatHours(l.quantity_minutes)}</td>
              <td class="num">${l.rate != null ? formatMoney(l.rate, currency) : '—'}</td>
              <td class="num">${formatMoney(l.amount, currency)}</td>
            </tr>`
        )
        .join('');

    const notesBlock =
        invoice.notes && invoice.notes.trim() !== ''
            ? `<section class="notes">
                 <h3>Notes</h3>
                 <p>${escapeHtml(invoice.notes)}</p>
               </section>`
            : '';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Invoice ${escapeHtml(invoice.number)}</title>
  <style>
    :root {
      --bg: #ffffff;
      --fg: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
      --primary: #2f7593;
      --primary-soft: rgba(47, 117, 147, 0.08);
      --slate-100: #f1f5f9;
    }
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .tabular { font-variant-numeric: tabular-nums; }
    .page { padding: 14mm 16mm; }

    .brand {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .brand-company { font-size: 15px; font-weight: 600; margin: 0; }
    .brand-address { max-width: 320px; font-size: 10.5px; line-height: 1.5; color: var(--muted); margin: 4px 0 0; }
    .brand-email { font-size: 10.5px; color: var(--muted); margin: 3px 0 0; }
    .brand-ids { font-size: 9.5px; color: var(--muted); margin: 6px 0 0; letter-spacing: 0.04em; }
    .brand-right { text-align: right; }
    .brand-title { font-size: 26px; font-weight: 700; letter-spacing: 0.02em; margin: 0; }
    .brand-number { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .status-badge {
      display: inline-block;
      margin-top: 10px;
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--slate-100);
      color: var(--fg);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-top: 22px;
    }
    .meta h3 {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
      margin: 0 0 6px;
    }
    .meta .bill-to-name { font-size: 13px; font-weight: 600; margin: 0; }
    .meta dl { margin: 8px 0 0; font-size: 11px; }
    .meta .info-row { display: grid; grid-template-columns: 90px 1fr; gap: 8px; padding: 2px 0; }
    .meta dt { color: var(--muted); margin: 0; }
    .meta dd { margin: 0; }

    table.lines {
      width: 100%;
      border-collapse: collapse;
      margin-top: 24px;
      font-size: 11px;
    }
    table.lines thead th {
      text-align: left;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      padding: 6px 8px;
      border-bottom: 2px solid var(--border);
    }
    table.lines thead th.num { text-align: right; }
    table.lines tbody td {
      padding: 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    table.lines tbody td.num { text-align: right; white-space: nowrap; }

    .totals { margin-top: 16px; margin-left: auto; width: 260px; font-size: 11.5px; }
    .totals .row { display: flex; justify-content: space-between; padding: 4px 8px; }
    .totals .row.total {
      margin-top: 6px;
      border-top: 2px solid var(--border);
      padding-top: 8px;
      font-size: 14px;
      font-weight: 700;
      background: var(--primary-soft);
      border-radius: 6px;
    }

    .notes { margin-top: 24px; font-size: 11px; color: var(--fg); }
    .notes h3 {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
      margin: 0 0 6px;
    }
    .notes p { margin: 0; line-height: 1.5; white-space: pre-wrap; }

    .footer {
      margin-top: 28px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      font-size: 9.5px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="brand">
      <div>
        <p class="brand-company">${field(settings.company_legal_name)}</p>
        <p class="brand-address">${field((settings.company_address_lines ?? []).join(' · '))}</p>
        <p class="brand-email">${field(settings.company_email)}</p>
        <p class="brand-ids">CIN: ${field(settings.cin_no)} · IEC: ${field(settings.iec_code)}</p>
      </div>
      <div class="brand-right">
        <h1 class="brand-title">INVOICE</h1>
        <div class="brand-number tabular">${escapeHtml(invoice.number)}</div>
        <span class="status-badge">${statusLabel}</span>
      </div>
    </div>

    <div class="meta">
      <div>
        <h3>Bill To</h3>
        <p class="bill-to-name">${field(company.name)}</p>
      </div>
      <div>
        <h3>Invoice Details</h3>
        <dl>
          <div class="info-row"><dt>Period</dt><dd>${formatDate(invoice.period_start)} – ${formatDate(invoice.period_end)}</dd></div>
          <div class="info-row"><dt>Issue Date</dt><dd>${formatDate(invoice.issue_date)}</dd></div>
          <div class="info-row"><dt>Due Date</dt><dd>${formatDate(invoice.due_date)}</dd></div>
        </dl>
      </div>
    </div>

    <table class="lines">
      <thead>
        <tr>
          <th>Description</th>
          <th class="num">Hours</th>
          <th class="num">Rate</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${lineRows}
      </tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Subtotal</span><span class="tabular">${formatMoney(invoice.subtotal, currency)}</span></div>
      <div class="row"><span>${field(invoice.tax_label)} (${invoice.tax_rate}%)</span><span class="tabular">${formatMoney(invoice.tax_amount, currency)}</span></div>
      <div class="row total"><span>Total</span><span class="tabular">${formatMoney(invoice.total, currency)}</span></div>
    </div>

    ${notesBlock}

    <div class="footer">
      This is a system-generated invoice. For queries, please contact ${field(settings.company_email)}.
    </div>
  </div>
</body>
</html>`;
}

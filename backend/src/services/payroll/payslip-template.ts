import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface LineItem {
  label: string;
  amount: number;
}

export interface PayslipRenderData {
  // Company
  companyName: string;
  companyAddress: string[];
  companyEmail: string;
  cinNo: string;
  iecCode: string;
  // Period
  payPeriod: string;
  // Employee
  employeeName: string;
  employeeNumber: string;
  function: string;
  designation: string;
  location: string;
  bankDetails: string;
  dateOfJoining: string;
  taxRegime: string;
  pan: string;
  uan: string;
  pfAccountNumber: string;
  esiNumber: string;
  pranNumber: string;
  daysPresent: number;
  earnings: LineItem[];
  deductions: LineItem[];
}

// ── Asset loading (logo, stamp, signature) ──────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try frontend assets first (canonical), fall back to api/assets if mirrored.
const candidateAssetDirs = [
  path.resolve(__dirname, "../../assets/payroll"),
  path.resolve(__dirname, "../../../payslip-app/src/assets"),
  path.resolve(__dirname, "../../assets"),
];

function loadAssetDataUri(filename: string, mime = "image/png"): string {
  for (const dir of candidateAssetDirs) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      return `data:${mime};base64,${buf.toString("base64")}`;
    }
  }
  return "";
}

const LOGO_DATA = loadAssetDataUri("viljetech-logo.svg", "image/svg+xml");
const STAMP_DATA = loadAssetDataUri("stamp.png");
const SIG_DATA = loadAssetDataUri("sign-for-payslip.png");

// ── Helpers ─────────────────────────────────────────────────────────────────
const formatINR = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0);

const sum = (items: LineItem[]) =>
  items.reduce((acc, it) => acc + (Number.isFinite(it.amount) ? it.amount : 0), 0);

const escape = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );

const field = (s: unknown): string => {
  const str = String(s ?? "").trim();
  return str === "" ? "-" : escape(str);
};

// Indian numbering words: copied from frontend src/lib/numberToWords.ts
const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
];
const twoDigits = (n: number): string => {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t] : `${TENS[t]} ${ONES[o]}`;
};
const threeDigits = (n: number): string => {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${ONES[h]} Hundred`);
  if (r > 0) parts.push(twoDigits(r));
  return parts.join(" ");
};
function numberToIndianWords(amount: number): string {
  if (!isFinite(amount)) return "";
  if (amount === 0) return "Zero";
  const isNegative = amount < 0;
  const abs = Math.abs(Math.round(amount));
  const crore = Math.floor(abs / 10_000_000);
  const lakh = Math.floor((abs % 10_000_000) / 100_000);
  const thousand = Math.floor((abs % 100_000) / 1000);
  const remainder = abs % 1000;
  const parts: string[] = [];
  if (crore > 0) parts.push(`${twoDigits(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${twoDigits(thousand)} Thousand`);
  if (remainder > 0) parts.push(threeDigits(remainder));
  const words = parts.join(" ").replace(/\s+/g, " ").trim();
  return isNegative ? `Minus ${words}` : words;
}

const issuedToday = () =>
  new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

const infoRow = (label: string, value: string) => `
  <div class="info-row">
    <dt>${escape(label)}</dt>
    <dd>${field(value)}</dd>
  </div>`;

// ── Template ────────────────────────────────────────────────────────────────
export function renderPayslipHtmlFromData(d: PayslipRenderData): string {
  const earnings = d.earnings ?? [];
  const deductions = d.deductions ?? [];
  const totalEarnings = sum(earnings);
  const totalDeductions = sum(deductions);
  const net = totalEarnings - totalDeductions;
  const netInWords = `INR ${numberToIndianWords(net)} Only`;

  // Pad the shorter side so both tables' footers align horizontally.
  const padCount = Math.max(0, earnings.length - deductions.length);
  const padRows = Array.from({ length: padCount })
    .map(() => `<tr class="pad"><td>&nbsp;</td><td>&nbsp;</td></tr>`)
    .join("");
  const padCountEarn = Math.max(0, deductions.length - earnings.length);
  const padRowsEarn = Array.from({ length: padCountEarn })
    .map(() => `<tr class="pad"><td>&nbsp;</td><td>&nbsp;</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Payslip — ${escape(d.employeeName)} — ${escape(d.payPeriod)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #ffffff;
      --fg: #0f172a;
      --muted: #64748b;
      --muted-soft: #94a3b8;
      --border: #e2e8f0;
      --border-soft: #eef2f6;
      --primary: #2f7593;       /* matches the ocean theme primary */
      --primary-soft: rgba(47, 117, 147, 0.08);
      --primary-soft-2: rgba(47, 117, 147, 0.05);
      --primary-strong: rgba(47, 117, 147, 0.30);
      --emerald: #10b981;
      --rose: #f43f5e;
      --slate-50: #f8fafc;
      --slate-100: #f1f5f9;
      --muted-bg: rgba(241, 245, 249, 0.5);
    }
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-feature-settings: "ss01", "cv01", "cv11";
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .display {
      font-family: "Instrument Serif", "Cormorant Garamond", Georgia, serif;
      letter-spacing: -0.01em;
      font-weight: 400;
    }
    .tabular { font-variant-numeric: tabular-nums; }
    .uppercase { text-transform: uppercase; }
    .muted { color: var(--muted); }

    /* Page wrapper — equal top/bottom margin, no side whitespace */
    .page {
      padding: 10mm 0;
    }
    .sheet {
      width: 100%;
      margin: 0;
      background: #ffffff;
      border: none;
      border-radius: 0;
      overflow: hidden;
      box-shadow: none;
    }

    /* ── Brand strip ── */
    .brand {
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      gap: 24px;
      padding: 20px 28px;
      border-bottom: 1px solid var(--border);
      background: #ffffff;
    }
    .brand-left { display: flex; align-items: flex-start; gap: 14px; }
    .brand-block {
      display: flex;
      align-items: center;
      margin-top: 2px;
      flex: 0 0 auto;
    }
    .brand-logo {
      width: 128px;
      height: 28px;
      object-fit: contain;
      object-position: left center;
      flex: 0 0 auto;
    }
    .brand-meta {
      padding-left: 14px;
      border-left: 1px solid var(--border-soft);
    }
    .brand-eyebrow {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--primary);
    }
    .brand-company {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.25;
      color: var(--fg);
      margin: 2px 0 0;
    }
    .brand-address {
      max-width: 320px;
      font-size: 10.5px;
      line-height: 1.5;
      color: var(--muted);
      margin: 2px 0 0;
    }
    .brand-email {
      font-size: 10.5px;
      color: var(--muted);
      margin: 3px 0 0;
    }
    .brand-right {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      justify-content: space-between;
      text-align: right;
    }
    .brand-title {
      font-size: 28px;
      line-height: 1;
      color: var(--fg);
    }
    .brand-period {
      margin-top: 4px;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--muted);
    }
    .badge {
      display: inline-block;
      margin-top: 10px;
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--slate-100);
      color: var(--fg);
      font-size: 10px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      white-space: nowrap;
    }

    /* ── Body ── */
    .body { padding: 22px 28px 24px; display: flex; flex-direction: column; gap: 18px; }

    /* Employee section */
    .emp-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 12px;
    }
    .emp-eyebrow {
      font-size: 10.5px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
    }
    .emp-name {
      font-size: 24px;
      line-height: 1.1;
      color: var(--fg);
      margin: 2px 0 0;
    }
    .emp-issued {
      text-align: right;
      font-size: 10.5px;
      color: var(--muted);
      line-height: 1.45;
    }
    .emp-issued strong {
      color: var(--fg);
      font-weight: 500;
    }

    .emp-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: 32px;
      row-gap: 2px;
      padding: 12px 16px;
      border: 1px dashed var(--border);
      border-radius: 10px;
      background: var(--muted-bg);
    }
    .emp-grid dl { margin: 0; }
    .info-row {
      display: grid;
      grid-template-columns: 130px 1fr;
      align-items: baseline;
      gap: 10px;
      padding: 3px 0;
    }
    .info-row dt {
      font-size: 10.5px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin: 0;
    }
    .info-row dd {
      font-size: 12px;
      color: var(--fg);
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    /* ── Earnings & Deductions ── */
    .ed-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      align-items: start;
    }
    .ed-title {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .dot {
      width: 6px; height: 6px; border-radius: 999px;
      display: inline-block;
    }
    .dot.emerald { background: var(--emerald); }
    .dot.rose { background: var(--rose); }
    .ed-title h3 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--fg);
      margin: 0;
    }
    table.ed {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      table-layout: fixed;
    }
    table.ed col.particulars { width: auto; }
    table.ed col.amount { width: 92px; }
    table.ed thead th {
      font-size: 10px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      text-align: left;
      padding: 5px 6px;
      border-bottom: 1px solid rgba(226, 232, 240, 0.6);
      background: transparent;
      white-space: nowrap;
    }
    table.ed thead th.num { text-align: right; }
    table.ed tbody td {
      padding: 6px 6px;
      border-bottom: 1px solid rgba(226, 232, 240, 0.4);
      color: var(--fg);
      vertical-align: middle;
      overflow-wrap: anywhere;
      word-break: break-word;
      white-space: normal;
    }
    table.ed tbody td.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    table.ed tbody tr.pad td {
      color: transparent;
      border-bottom-color: rgba(226, 232, 240, 0.4);
    }
    table.ed tfoot td {
      padding: 7px 6px;
      border-top: 2px solid var(--border);
      background: rgba(241, 245, 249, 0.4);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      white-space: nowrap;
    }
    table.ed tfoot td.num {
      text-align: right;
      font-size: 11.5px;
      font-weight: 600;
      text-transform: none;
      letter-spacing: 0;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    /* ── Net pay banner ── */
    .net {
      border: 1px solid var(--primary-strong);
      border-radius: 12px;
      background:
        linear-gradient(135deg, var(--primary-soft) 0%, var(--primary-soft-2) 60%, transparent 100%);
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .net-eyebrow {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--primary);
    }
    .net-words {
      max-width: 460px;
      margin: 3px 0 0;
      font-size: 10.5px;
      line-height: 1.5;
      color: var(--muted);
    }
    .net-amount {
      text-align: right;
    }
    .net-amount .big {
      font-size: 30px;
      line-height: 1;
      color: var(--fg);
      font-variant-numeric: tabular-nums;
    }
    .net-amount .sub {
      margin-top: 3px;
      font-size: 9.5px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--muted);
    }

    .sep {
      height: 1px;
      background: rgba(226, 232, 240, 0.6);
      width: 100%;
      margin: 0;
    }

    /* ── Footer / signature ── */
    .footer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 20px;
      align-items: end;
    }
    .legal {
      font-size: 10.5px;
      line-height: 1.5;
      color: var(--muted);
    }
    .legal strong { color: var(--fg); font-weight: 500; }
    .legal .ids {
      padding-top: 4px;
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
      font-size: 9.5px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted-soft);
    }
    .sign-block {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    /* Stamp + signature: signature overlays the LEFT side of the stamp. */
    .sign-stage {
      position: relative;
      width: 260px;
      height: 150px;
      margin: 0 auto;
    }
    /* Stamp frame: source PNG has lots of whitespace, so we crop in. */
    .stamp-frame {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: 0;
      width: 140px;
      height: 140px;
      overflow: hidden;
    }
    .stamp-frame img {
      position: absolute;
      width: 250px;     /* zoom so the stamp circle fills the frame */
      height: auto;
      left: -54px;
      top: -143px;
      opacity: 0.92;
    }
    .signature {
      position: absolute;
      left: 0;
      top: 28px;
      height: 120px;
      width: 190px;
      object-fit: contain;
      z-index: 2;
    }
    .sign-line {
      width: 240px;
      height: 1px;
      background: rgba(15, 23, 42, 0.3);
      margin-top: 4px;
    }
    .sign-label {
      margin-top: 6px;
      font-size: 10.5px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--fg);
    }
    .sign-sub {
      font-size: 9.5px;
      color: var(--muted);
      margin-top: 1px;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="sheet">
      <!-- ── Brand strip ── -->
      <div class="brand">
        <div class="brand-left">
          <div class="brand-block">
            ${LOGO_DATA ? `<img class="brand-logo" src="${LOGO_DATA}" width="128" height="28" alt="Viljetech" />` : ""}
          </div>
          <div class="brand-meta">
            <div class="brand-eyebrow">Payslip</div>
            <h1 class="brand-company">${field(d.companyName)}</h1>
            <p class="brand-address">${field((d.companyAddress ?? []).join(" · "))}</p>
            <p class="brand-email">${field(d.companyEmail)}</p>
          </div>
        </div>
        <div class="brand-right">
          <div>
            <div class="display brand-title">Pay Slip</div>
            <div class="brand-period">For ${field(d.payPeriod)}</div>
          </div>
          <span class="badge">${escape(d.taxRegime || "Regular Tax Regime")}</span>
        </div>
      </div>

      <!-- ── Body ── -->
      <div class="body">
        <!-- Employee block -->
        <section>
          <div class="emp-head">
            <div>
              <div class="emp-eyebrow">Employee</div>
              <h2 class="display emp-name">${field(d.employeeName)}</h2>
            </div>
            <div class="emp-issued">
              <div>Issued on <strong>${issuedToday()}</strong></div>
              <div style="margin-top:2px">Days present: <strong class="tabular">${d.daysPresent ?? 0}</strong></div>
            </div>
          </div>
          <div class="emp-grid">
            <dl>
              ${infoRow("Employee No.", d.employeeNumber)}
              ${infoRow("Function", d.function)}
              ${infoRow("Designation", d.designation)}
              ${infoRow("Location", d.location)}
              ${infoRow("Date of Joining", d.dateOfJoining)}
            </dl>
            <dl>
              ${infoRow("PAN", d.pan)}
              ${infoRow("UAN", d.uan)}
              ${infoRow("PF Account", d.pfAccountNumber)}
              ${infoRow("ESI Number", d.esiNumber)}
              ${infoRow("Bank Details", d.bankDetails)}
            </dl>
          </div>
        </section>

        <!-- Earnings & Deductions side-by-side -->
        <section class="ed-grid">
          <div>
            <div class="ed-title">
              <span class="dot emerald"></span>
              <h3>Earnings</h3>
            </div>
            <table class="ed">
              <colgroup>
                <col class="particulars" />
                <col class="amount" />
              </colgroup>
              <thead>
                <tr>
                  <th>Particulars</th>
                  <th class="num">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                ${earnings
      .map(
        (e) => `<tr>
                      <td>${escape(e.label)}</td>
                      <td class="num">${formatINR(e.amount)}</td>
                    </tr>`
      )
      .join("")}
                ${padRowsEarn}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total Earnings</td>
                  <td class="num">₹ ${formatINR(totalEarnings)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div>
            <div class="ed-title">
              <span class="dot rose"></span>
              <h3>Deductions</h3>
            </div>
            <table class="ed">
              <colgroup>
                <col class="particulars" />
                <col class="amount" />
              </colgroup>
              <thead>
                <tr>
                  <th>Particulars</th>
                  <th class="num">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                ${deductions
      .map(
        (item) => `<tr>
                      <td>${escape(item.label)}</td>
                      <td class="num">${formatINR(item.amount)}</td>
                    </tr>`
      )
      .join("")}
                ${padRows}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total Deductions</td>
                  <td class="num">₹ ${formatINR(totalDeductions)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <!-- Net pay banner -->
        <section class="net">
          <div>
            <div class="net-eyebrow">Net Pay for ${field(d.payPeriod)}</div>
            <div class="net-words">${escape(netInWords)}</div>
          </div>
          <div class="net-amount">
            <div class="display big">₹ ${formatINR(net)}</div>
            <div class="sub">INR · Indian Rupees</div>
          </div>
        </section>

        <hr class="sep" />

        <!-- Footer: legal + signature/stamp -->
        <section class="footer">
          <div class="legal">
            <p style="margin:0">
              This is a system-generated payslip and does not require a physical signature when issued electronically.
            </p>
            <p style="margin:6px 0 0">
              For queries, please contact <strong>hr@viljetech.com</strong>.
            </p>
            <div class="ids">CIN: ${field(d.cinNo)} · IEC: ${field(d.iecCode)}</div>
          </div>
          <div class="sign-block">
            <div class="sign-stage">
              ${STAMP_DATA ? `<div class="stamp-frame"><img src="${STAMP_DATA}" alt="" /></div>` : ""}
              ${SIG_DATA ? `<img class="signature" src="${SIG_DATA}" alt="" />` : ""}
            </div>
            <div class="sign-line"></div>
            <div class="sign-label">Authorised Signatory</div>
            <div class="sign-sub">for ${field(d.companyName)}</div>
          </div>
        </section>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function payslipNetPayFromData(d: PayslipRenderData) {
  return sum(d.earnings) - sum(d.deductions);
}

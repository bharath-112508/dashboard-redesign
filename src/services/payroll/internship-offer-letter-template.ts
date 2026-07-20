import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Internship OFFER letter.
 *
 * Distinct from the existing `internship` type, which renders an "Internship
 * Experience Letter" — issued when an internship ENDS. This one is issued at
 * the start: it states the position, the fixed window, work mode and whether
 * the internship is paid, then lists responsibilities and terms.
 *
 * It has its own template rather than a third variant of the offer letter
 * because the shared bits (CTC breakdown, probation, notice period, reporting
 * manager) don't apply, and the two sections that matter here — Roles &
 * Responsibilities and General Terms — don't exist there. Folding it in would
 * have meant conditionals through a 700-line file. The visual language (CSS
 * variables, header, signature block) is deliberately identical.
 */

export interface InternshipOfferRenderData {
    // Company
    companyName: string;
    companyAddress: string[];
    companyEmail: string;
    cinNo: string;
    iecCode: string;

    // Letter meta
    issueDate: string;
    reference?: string;
    /** Optional deadline for the intern to accept. */
    offerValidUntil?: string;

    // Intern
    internName: string;
    internAddress: string[];
    internEmail: string;
    internPhone?: string;

    // Internship details
    position: string;
    /** Formatted for print, e.g. "18 July 2026". */
    startDate: string;
    endDate: string;
    /** Free text so "3 Months", "12 Weeks" and "3.5 Months" all render. */
    durationLabel: string;
    workMode: string;

    // Compensation
    isPaid: boolean;
    /** Monthly stipend in INR. Only meaningful when `isPaid`. */
    stipendAmount?: number;
    /** Optional qualifier, e.g. "paid on the 5th of each month". */
    stipendNote?: string;

    // Body
    bodyParagraphs?: string[];
    responsibilities: string[];
    terms: string[];
    closing?: string;
    signatoryName?: string;
    signatoryTitle?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidateAssetDirs = [
    path.resolve(__dirname, '../../assets/payroll'),
    path.resolve(__dirname, '../../../payslip-app/src/assets'),
    path.resolve(__dirname, '../../assets'),
];

function loadAssetDataUri(filename: string, mime = 'image/png'): string {
    for (const dir of candidateAssetDirs) {
        const p = path.join(dir, filename);
        if (fs.existsSync(p)) {
            const buf = fs.readFileSync(p);
            return `data:${mime};base64,${buf.toString('base64')}`;
        }
    }
    return '';
}

const LOGO_DATA = loadAssetDataUri('viljetech-logo.svg', 'image/svg+xml');
const STAMP_DATA = loadAssetDataUri('stamp.png');
const SIG_DATA = loadAssetDataUri('sign-for-payslip.png');

const escape = (s: string) =>
    String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
    );

const field = (s: unknown): string => {
    const str = String(s ?? '').trim();
    return str === '' ? '-' : escape(str);
};

const fmtINR = (n: number | undefined): string => {
    if (!Number.isFinite(n)) return '0';
    return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format((n as number) || 0);
};

const issuedToday = () =>
    new Date().toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    });

/**
 * The compensation line, in both the facts grid and the body.
 *
 * Unpaid is stated explicitly rather than left blank — an internship offer
 * that simply omits compensation is the kind of ambiguity that turns into a
 * dispute later.
 */
export function compensationLine(d: InternshipOfferRenderData): string {
    if (!d.isPaid) return 'This is an unpaid internship.';
    const amount = `₹${fmtINR(d.stipendAmount)} per month`;
    return d.stipendNote?.trim() ? `Stipend of ${amount} (${d.stipendNote.trim()}).` : `Stipend of ${amount}.`;
}

function defaultBody(d: InternshipOfferRenderData): string[] {
    const name = escape(d.internName || 'Candidate');
    const company = escape(d.companyName || 'the Company');
    const position = d.position ? `<strong>${escape(d.position)}</strong>` : 'an internship position';
    return [
        `Dear ${name},`,
        `We are pleased to offer you an internship with ${company} as ${position}. This letter sets out the details of your internship, the responsibilities you will take on, and the terms that apply.`,
        'We look forward to your contribution and hope this internship is a valuable learning experience for you.',
    ];
}

/** Standard clauses. The caller may replace these entirely. */
export const DEFAULT_INTERNSHIP_TERMS: string[] = [
    'This internship is for the fixed duration stated above and does not constitute an offer of employment, nor a guarantee of employment at the end of the term.',
    'You are expected to maintain strict confidentiality of all proprietary, technical and business information you access during the internship, both during and after the term.',
    'All work product, code, documentation and intellectual property created during the internship remains the property of the Company.',
    "You are expected to conduct yourself professionally and to comply with the Company's policies, including its code of conduct and information-security policies.",
    'Either party may end the internship earlier by giving written notice; the Company may end it immediately in the event of misconduct or breach of these terms.',
    'A certificate of completion will be issued at the end of the term, subject to satisfactory performance and completion of the agreed duration.',
];

export const DEFAULT_INTERNSHIP_RESPONSIBILITIES: string[] = [
    'Work on assigned projects under the guidance of your mentor and the wider team.',
    'Participate in team discussions, reviews and stand-ups relevant to your work.',
    'Document your work and hand over deliverables in a reusable state.',
    'Learn and apply the tools, standards and practices used by the team.',
];

export function renderInternshipOfferLetterHtml(d: InternshipOfferRenderData): string {
    const issueDate = d.issueDate || issuedToday();
    const refCode = d.reference || `HR/INT/${issueDate.replace(/\s+/g, '-')}`;
    const paragraphs = d.bodyParagraphs?.length ? d.bodyParagraphs : defaultBody(d);
    const responsibilities = d.responsibilities?.length ? d.responsibilities : DEFAULT_INTERNSHIP_RESPONSIBILITIES;
    const terms = d.terms?.length ? d.terms : DEFAULT_INTERNSHIP_TERMS;
    const closing = d.closing || 'Yours sincerely,';
    const signatoryName = d.signatoryName || 'Santhosh Reddy Panyala';
    const signatoryTitle = d.signatoryTitle || 'Human Resources';

    const internAddressHtml = (d.internAddress ?? []).map((line) => `<div>${escape(line)}</div>`).join('');

    const facts: Array<{ label: string; value: string }> = [
        { label: 'Position', value: field(d.position) },
        {
            label: 'Internship duration',
            value: d.startDate || d.endDate ? `${field(d.startDate)} &ndash; ${field(d.endDate)}` : '-',
        },
        { label: 'Duration', value: field(d.durationLabel) },
        { label: 'Work mode', value: field(d.workMode) },
        { label: 'Compensation', value: escape(compensationLine(d)) },
    ];

    const factsHtml = facts
        .map(
            (f) => `
        <div class="fact-cell">
          <div class="fact-label">${escape(f.label)}</div>
          <div class="fact-value">${f.value}</div>
        </div>`
        )
        .join('');

    const listHtml = (items: string[]) => items.map((t) => `<li>${escape(t)}</li>`).join('');

    const validityHtml = d.offerValidUntil
        ? `<p class="para">Please confirm your acceptance by signing and returning this letter on or before <strong>${escape(
              d.offerValidUntil
          )}</strong>.</p>`
        : '';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Internship Offer Letter — ${escape(d.internName)}</title>
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
      --primary: #2f7593;
      --slate-50: #f8fafc;
      --slate-100: #f1f5f9;
    }
    @page { size: A4; margin: 14mm 0; }
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
    .sheet { width: 186mm; margin: 0 auto; padding: 0 2mm; }
    .head {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 16px; padding-bottom: 12px; border-bottom: 2px solid var(--primary);
    }
    .logo { height: 34px; }
    .co-meta { text-align: right; font-size: 9.5px; color: var(--muted); line-height: 1.5; }
    .co-name { font-size: 12px; font-weight: 700; color: var(--fg); }
    .title-row {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 12px; margin: 18px 0 4px;
    }
    h1 {
      font-family: "Instrument Serif", Georgia, serif;
      font-size: 26px; font-weight: 400; margin: 0; letter-spacing: -0.01em;
    }
    .meta { font-size: 9.5px; color: var(--muted); text-align: right; line-height: 1.6; }
    .addr { margin: 14px 0 6px; font-size: 10.5px; line-height: 1.6; }
    .addr .to { color: var(--muted-soft); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 3px; }
    .addr .nm { font-weight: 600; font-size: 11.5px; }
    .para { font-size: 10.5px; line-height: 1.75; margin: 9px 0; text-align: justify; }
    h2 {
      font-size: 11px; font-weight: 700; margin: 20px 0 8px;
      text-transform: uppercase; letter-spacing: .07em; color: var(--primary);
    }
    .facts {
      display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
      background: var(--border-soft); border: 1px solid var(--border);
      border-radius: 8px; overflow: hidden;
    }
    /* The compensation line is the longest and most consequential value —
       give it the full width so it never wraps mid-sentence in a half cell. */
    .fact-cell:last-child { grid-column: 1 / -1; }
    .fact-cell { background: #fff; padding: 9px 12px; }
    .fact-label { font-size: 8.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted-soft); }
    .fact-value { font-size: 10.5px; font-weight: 600; margin-top: 2px; }
    ol.clauses, ul.duties { margin: 6px 0 0; padding-left: 18px; }
    ol.clauses li, ul.duties li {
      font-size: 10px; line-height: 1.7; margin-bottom: 6px; text-align: justify;
    }
    .sign-row {
      display: flex; justify-content: space-between; align-items: flex-end;
      gap: 24px; margin-top: 26px;
    }
    .sign-block { font-size: 10px; line-height: 1.6; }
    .sign-img { height: 42px; display: block; margin-bottom: 2px; }
    .stamp { height: 68px; opacity: .9; }
    .sign-name { font-weight: 700; font-size: 10.5px; }
    .sign-title { color: var(--muted); font-size: 9.5px; }
    .accept {
      margin-top: 22px; padding: 12px 14px; border: 1px dashed var(--border);
      border-radius: 8px; background: var(--slate-50);
    }
    .accept-h { font-size: 10px; font-weight: 700; margin-bottom: 14px; }
    .accept-line { display: flex; gap: 26px; font-size: 9.5px; color: var(--muted); }
    .accept-line > div { flex: 1; border-top: 1px solid var(--border); padding-top: 4px; }
    .legal {
      margin-top: 16px; padding-top: 8px; border-top: 1px solid var(--border-soft);
      font-size: 8.5px; color: var(--muted-soft); line-height: 1.6; text-align: center;
    }
    /* Keep a section's heading with at least its first lines. */
    h2, .facts { break-inside: avoid; page-break-inside: avoid; }
    li { break-inside: avoid; }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="head">
      <div>${LOGO_DATA ? `<img class="logo" src="${LOGO_DATA}" alt="" />` : `<div class="co-name">${escape(d.companyName)}</div>`}</div>
      <div class="co-meta">
        <div class="co-name">${escape(d.companyName)}</div>
        ${(d.companyAddress ?? []).map((l) => `<div>${escape(l)}</div>`).join('')}
        ${d.companyEmail ? `<div>${escape(d.companyEmail)}</div>` : ''}
        ${d.cinNo ? `<div>CIN: ${escape(d.cinNo)}</div>` : ''}
        ${d.iecCode ? `<div>IEC: ${escape(d.iecCode)}</div>` : ''}
      </div>
    </div>

    <div class="title-row">
      <h1>Internship Offer Letter</h1>
      <div class="meta">
        <div>Ref: ${escape(refCode)}</div>
        <div>Date: ${escape(issueDate)}</div>
      </div>
    </div>

    <div class="addr">
      <div class="to">To</div>
      <div class="nm">${escape(d.internName)}</div>
      ${internAddressHtml}
      ${d.internEmail ? `<div>${escape(d.internEmail)}</div>` : ''}
      ${d.internPhone ? `<div>${escape(d.internPhone)}</div>` : ''}
    </div>

    ${paragraphs.map((p) => `<p class="para">${p}</p>`).join('')}

    <h2>Internship Details</h2>
    <div class="facts">${factsHtml}</div>

    <h2>Roles and Responsibilities</h2>
    <p class="para">During your internship, you will have the opportunity to work on projects and support the team in areas such as:</p>
    <ul class="duties">${listHtml(responsibilities)}</ul>

    <h2>General Terms and Conditions</h2>
    <ol class="clauses">${listHtml(terms)}</ol>

    ${validityHtml}

    <div class="sign-row">
      <div class="sign-block">
        <div>${escape(closing)}</div>
        ${SIG_DATA ? `<img class="sign-img" src="${SIG_DATA}" alt="" />` : '<div style="height:42px"></div>'}
        <div class="sign-name">${escape(signatoryName)}</div>
        <div class="sign-title">${escape(signatoryTitle)}</div>
        <div class="sign-title">${escape(d.companyName)}</div>
      </div>
      ${STAMP_DATA ? `<img class="stamp" src="${STAMP_DATA}" alt="" />` : ''}
    </div>

    <div class="accept">
      <div class="accept-h">Accepted and agreed,</div>
      <div class="accept-line">
        <div>Intern's signature</div>
        <div>Name</div>
        <div>Date</div>
      </div>
    </div>

    <div class="legal">
      This is a system-generated internship offer letter and is valid without a wet signature.
      Please sign and return a copy in acknowledgement for our records.
    </div>
  </div>
</body>
</html>`;
}

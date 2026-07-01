import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface OfferCtcRow {
  label: string;
  amount: number;
  note?: string;
}

export interface OfferLetterRenderData {
  // Company
  companyName: string;
  companyAddress: string[];
  companyEmail: string;
  cinNo: string;
  iecCode: string;

  // Letter meta
  issueDate: string;
  reference?: string;
  offerValidUntil?: string;

  // Candidate
  candidateName: string;
  candidateAddress: string[];
  candidateEmail: string;
  candidatePhone?: string;

  // Role
  designation: string;
  department: string;
  location: string;
  reportingManager: string;
  joiningDate: string;
  employmentType: string;

  // Terms
  probationMonths: number;
  noticePeriodDays: number;
  workingHours: string;
  workingDays: string;

  // Compensation
  ctcBreakdown: OfferCtcRow[];

  // Body
  bodyParagraphs?: string[];
  termsParagraphs?: string[];
  closing?: string;
  signatoryName?: string;
  signatoryTitle?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const escape = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );

const field = (s: unknown): string => {
  const str = String(s ?? "").trim();
  return str === "" ? "-" : escape(str);
};

const fmtINR = (n: number | undefined): string => {
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    (n as number) || 0,
  );
};

function totalCtc(rows: OfferCtcRow[]): number {
  return rows.reduce(
    (s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0),
    0,
  );
}

const issuedToday = () =>
  new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

function defaultBody(d: OfferLetterRenderData): string[] {
  const name = escape(d.candidateName || "Candidate");
  const company = escape(d.companyName || "the Company");
  const role = d.designation
    ? `<strong>${escape(d.designation)}</strong>`
    : "the role offered";
  const deptSeg = d.department
    ? ` in the ${escape(d.department)} department`
    : "";
  const locSeg = d.location
    ? `, based at our ${escape(d.location)} office`
    : "";
  const doj = d.joiningDate
    ? `<strong>${escape(d.joiningDate)}</strong>`
    : "the agreed date of joining";
  const empType = d.employmentType
    ? `as a <strong>${escape(d.employmentType)}</strong> employee`
    : "as a full-time employee";
  const reportSeg = d.reportingManager
    ? ` You will report to <strong>${escape(d.reportingManager)}</strong>.`
    : "";

  return [
    `Dear ${name},`,
    `We are delighted to extend this offer of employment with <strong>${company}</strong>. Following our discussions and your interview process, we are pleased to confirm the offer for the position of ${role}${deptSeg}${locSeg}.`,
    `Your appointment will be ${empType}, with your tentative date of joining being ${doj}.${reportSeg}`,
    `The detailed compensation structure for your role is set out in the compensation table below. The total annual cost to company (CTC) reflects the value of all fixed and variable components of your remuneration.`,
  ];
}

function defaultTerms(d: OfferLetterRenderData): string[] {
  const probation = d.probationMonths > 0
    ? `Your employment will be subject to a probation period of <strong>${d.probationMonths} month${d.probationMonths === 1 ? "" : "s"}</strong> from the date of joining, during which either party may terminate the engagement with notice as specified below.`
    : `Your employment will be confirmed from the date of joining.`;
  const notice = d.noticePeriodDays > 0
    ? `Either party may terminate this engagement by serving a notice period of <strong>${d.noticePeriodDays} day${d.noticePeriodDays === 1 ? "" : "s"}</strong> in writing, or payment in lieu of notice.`
    : `Either party may terminate this engagement by serving notice in writing, in accordance with the terms of your appointment.`;
  const hours = d.workingHours || d.workingDays
    ? `Your standard working schedule will be <strong>${escape(d.workingHours || "regular business hours")}</strong>${d.workingDays ? ` on <strong>${escape(d.workingDays)}</strong>` : ""}. You may be required to work additional hours as the role demands.`
    : `Your working schedule will follow the standard hours and working days of the Company.`;
  const valid = d.offerValidUntil
    ? `This offer is valid until <strong>${escape(d.offerValidUntil)}</strong>. Please confirm your acceptance by signing this letter and returning it to us before that date.`
    : `Please confirm your acceptance by signing this letter and returning it to us at the earliest.`;

  return [
    probation,
    notice,
    hours,
    `Your employment will be subject to satisfactory completion of background verification, reference checks, and submission of documents evidencing your prior employment, education, and identity.`,
    `You will be required to abide by the Company's policies on confidentiality, data protection, intellectual property, and code of conduct. The detailed policies will be shared with you on the date of joining.`,
    valid,
    `We are confident that you will find this opportunity both challenging and rewarding, and we look forward to welcoming you to the team.`,
  ];
}

export function renderOfferLetterHtml(d: OfferLetterRenderData): string {
  const headline = "Offer Letter";
  const refCode =
    d.reference ||
    `OFF/OFFER/${(d.issueDate || issuedToday()).replace(/\s+/g, "-")}`;
  const issueDate = d.issueDate || issuedToday();
  const paragraphs =
    d.bodyParagraphs && d.bodyParagraphs.length > 0 ? d.bodyParagraphs : defaultBody(d);
  const terms =
    d.termsParagraphs && d.termsParagraphs.length > 0 ? d.termsParagraphs : defaultTerms(d);
  const closing = d.closing || "Yours sincerely,";
  const signatoryName = d.signatoryName || "Santhosh Reddy Panyala";
  const signatoryTitle = d.signatoryTitle || "Human Resources";
  const total = totalCtc(d.ctcBreakdown);

  const candidateAddressHtml = (d.candidateAddress ?? [])
    .map((line) => `<div>${escape(line)}</div>`)
    .join("");

  const ctcRowsHtml = d.ctcBreakdown
    .map(
      (row) => `
        <tr>
          <td class="ctc-label">${field(row.label)}</td>
          <td class="ctc-note">${field(row.note)}</td>
          <td class="ctc-amount">${fmtINR(row.amount)}</td>
        </tr>`,
    )
    .join("");

  const facts: Array<{ label: string; value: string }> = [
    { label: "Designation", value: field(d.designation) },
    { label: "Department", value: field(d.department) },
    { label: "Location", value: field(d.location) },
    { label: "Reporting to", value: field(d.reportingManager) },
    { label: "Joining date", value: field(d.joiningDate) },
    { label: "Employment type", value: field(d.employmentType) },
    {
      label: "Probation",
      value: d.probationMonths > 0 ? `${d.probationMonths} months` : "-",
    },
    {
      label: "Notice period",
      value: d.noticePeriodDays > 0 ? `${d.noticePeriodDays} days` : "-",
    },
  ];
  const factsHtml = facts
    .map(
      (f) => `
        <div class="fact-cell">
          <div class="fact-label">${escape(f.label)}</div>
          <div class="fact-value">${f.value}</div>
        </div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escape(headline)} — ${escape(d.candidateName)}</title>
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
      --emerald-700: #047857;
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
    .display {
      font-family: "Instrument Serif", "Cormorant Garamond", Georgia, serif;
      letter-spacing: -0.01em;
      font-weight: 400;
    }
    .page { padding: 0; }
    .sheet { width: 100%; margin: 0; background: #ffffff; }

    /* Brand strip */
    .brand {
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      gap: 24px;
      padding: 10px 28px;
      border-bottom: 1px solid var(--border);
      background: #ffffff;
    }
    .brand-left { display: flex; align-items: flex-start; gap: 14px; }
    .brand-block { display: flex; align-items: center; margin-top: 2px; flex: 0 0 auto; }
    .brand-logo { width: 128px; height: 28px; object-fit: contain; object-position: left center; flex: 0 0 auto; }
    .brand-meta { padding-left: 14px; border-left: 1px solid var(--border-soft); }
    .brand-eyebrow {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.18em; color: var(--primary);
    }
    .brand-company { font-size: 14px; font-weight: 600; line-height: 1.25; color: var(--fg); margin: 2px 0 0; }
    .brand-address { max-width: 340px; font-size: 10.5px; line-height: 1.5; color: var(--muted); margin: 2px 0 0; }
    .brand-email { font-size: 10.5px; color: var(--muted); margin: 3px 0 0; }
    .brand-right { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; text-align: right; }
    .brand-title { font-size: 26px; line-height: 1; color: var(--fg); }
    .brand-meta-line { margin-top: 6px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.16em; color: var(--muted); }
    .ref-pill {
      display: inline-block; margin-top: 10px; padding: 3px 10px; border-radius: 999px;
      background: var(--slate-100); color: var(--fg);
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
      font-size: 10px; letter-spacing: 0.04em; white-space: nowrap;
    }

    /* Body */
    .body { padding: 14px 36px 10px; display: flex; flex-direction: column; gap: 14px; font-size: 12px; line-height: 1.6; color: var(--fg); }
    .body p { margin: 0; }
    .body p strong { font-weight: 600; }
    .meta-row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; font-size: 11px; color: var(--muted); }
    .meta-row strong { color: var(--fg); font-weight: 500; }

    h1.letter-headline {
      font-family: "Instrument Serif", Georgia, serif;
      font-size: 26px; line-height: 1.1; letter-spacing: -0.01em;
      margin: 2px 0 4px; color: var(--fg); text-align: center;
    }
    .underline { width: 64px; height: 2px; background: var(--primary); margin: 0 auto 4px; }

    .to-block {
      font-size: 12px; line-height: 1.55;
    }
    .to-eyebrow {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.18em; color: var(--primary); margin-bottom: 3px;
    }
    .to-name { font-weight: 600; color: var(--fg); }
    .to-line { color: var(--muted); }

    /* CTC table */
    .ctc-wrap {
      border: 1px solid var(--border); border-radius: 10px;
      padding: 10px 14px 8px; background: var(--slate-50);
      page-break-inside: avoid; break-inside: avoid;
    }
    .ctc-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
    .ctc-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; color: var(--primary); }
    .ctc-sub { font-size: 10px; color: var(--muted); }
    table.ctc { width: 100%; border-collapse: collapse; font-size: 11.5px; }
    table.ctc th {
      text-align: left; font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.14em; color: var(--muted); padding: 4px 0; font-weight: 500;
    }
    table.ctc th.col-amount { text-align: right; }
    table.ctc td { padding: 5px 0; border-top: 1px solid rgba(15,23,42,0.07); }
    .ctc-label { font-weight: 500; color: var(--fg); }
    .ctc-note { color: var(--muted); }
    .ctc-amount { text-align: right; font-variant-numeric: tabular-nums; }
    .ctc-total-row td { border-top: 1px solid rgba(15,23,42,0.3); padding-top: 8px; padding-bottom: 4px; }
    .ctc-total-label {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.14em; color: var(--fg);
    }
    .ctc-total-amount {
      text-align: right; font-size: 13px; font-weight: 600;
      color: var(--emerald-700); font-variant-numeric: tabular-nums;
    }

    /* At-a-glance */
    .facts {
      border: 1px solid var(--border); border-radius: 10px;
      padding: 10px 14px 8px; background: #ffffff;
      page-break-inside: avoid; break-inside: avoid;
    }
    .facts-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; color: var(--primary); margin-bottom: 6px; }
    .facts-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 24px; }
    .fact-cell { display: flex; flex-direction: column; gap: 2px; }
    .fact-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--muted); }
    .fact-value { font-size: 12px; font-weight: 500; color: var(--fg); }

    /* Terms */
    .terms { display: flex; flex-direction: column; gap: 6px; }
    .terms-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; color: var(--primary); }
    ol.terms-list { margin: 0; padding-left: 22px; font-size: 12px; line-height: 1.6; }
    ol.terms-list li { margin: 4px 0; }
    ol.terms-list li strong { font-weight: 600; }

    /* Signature */
    .sign-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 4px;
      page-break-inside: avoid; break-inside: avoid;
    }
    .sign-col {
      display: flex; flex-direction: column;
      page-break-inside: avoid; break-inside: avoid;
    }
    ol.terms-list li { page-break-inside: avoid; break-inside: avoid; }
    .closing { font-size: 12px; margin: 0 0 4px; }
    .sign-stage { position: relative; width: 230px; height: 96px; }
    .stamp-frame { position: absolute; left: 60px; top: 0; width: 96px; height: 96px; overflow: hidden; }
    .stamp-frame img { position: absolute; width: 172px; height: auto; left: -38px; top: -98px; opacity: 0.92; }
    .signature { position: absolute; left: 0; top: 14px; height: 80px; width: 150px; object-fit: contain; z-index: 2; }
    .sign-spacer { height: 96px; }
    .sign-line { width: 210px; height: 1px; background: rgba(15, 23, 42, 0.3); margin-top: 0; }
    .sign-name { margin-top: 2px; font-size: 12px; font-weight: 600; color: var(--fg); }
    .sign-title { font-size: 10.5px; color: var(--muted); }

    .legal {
      padding: 6px 36px 8px;
      border-top: 1px solid var(--border-soft);
      font-size: 10px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="sheet">
      <div class="brand">
        <div class="brand-left">
          <div class="brand-block">
            ${LOGO_DATA ? `<img class="brand-logo" src="${LOGO_DATA}" width="128" height="28" alt="Viljetech" />` : ""}
          </div>
          <div class="brand-meta">
            <div class="brand-eyebrow">${escape(headline)}</div>
            <h1 class="brand-company">${field(d.companyName)}</h1>
            <p class="brand-address">${field((d.companyAddress ?? []).join(" · "))}</p>
            <p class="brand-email">${field(d.companyEmail)}</p>
          </div>
        </div>
        <div class="brand-right">
          <div>
            <div class="display brand-title">${escape(headline)}</div>
            <div class="brand-meta-line">Issued · ${escape(issueDate)}</div>
          </div>
          <span class="ref-pill">Ref: ${escape(refCode)}</span>
        </div>
      </div>

      <div class="body">
        <div class="meta-row">
          <div>Date: <strong>${field(issueDate)}</strong></div>
          <div>Ref: <strong>${field(refCode)}</strong></div>
        </div>

        <div>
          <div class="underline"></div>
          <h1 class="letter-headline">${escape(headline)}</h1>
        </div>

        <div class="to-block">
          <div class="to-eyebrow">To</div>
          <div class="to-name">${field(d.candidateName)}</div>
          ${candidateAddressHtml ? `<div class="to-line">${candidateAddressHtml}</div>` : ""}
          ${d.candidateEmail ? `<div class="to-line">${escape(d.candidateEmail)}</div>` : ""}
        </div>

        ${paragraphs.map((p) => `<p>${p}</p>`).join("")}

        <div class="ctc-wrap">
          <div class="ctc-header">
            <div class="ctc-title">Compensation · Annual (INR)</div>
            <div class="ctc-sub">All figures in ₹ per year</div>
          </div>
          <table class="ctc">
            <thead>
              <tr>
                <th>Component</th>
                <th>Notes</th>
                <th class="col-amount">Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              ${ctcRowsHtml}
              <tr class="ctc-total-row">
                <td colspan="2" class="ctc-total-label">Total CTC</td>
                <td class="ctc-total-amount">₹ ${fmtINR(total)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="facts">
          <div class="facts-title">Engagement at a glance</div>
          <div class="facts-grid">
            ${factsHtml}
          </div>
        </div>

        <div class="terms">
          <div class="terms-title">Terms & Conditions</div>
          <ol class="terms-list">
            ${terms.map((t) => `<li>${t}</li>`).join("")}
          </ol>
        </div>

        <div class="sign-grid">
          <div class="sign-col">
            <p class="closing">${escape(closing)}</p>
            <div class="sign-stage">
              ${STAMP_DATA ? `<div class="stamp-frame"><img src="${STAMP_DATA}" alt="" /></div>` : ""}
              ${SIG_DATA ? `<img class="signature" src="${SIG_DATA}" alt="" />` : ""}
            </div>
            <div class="sign-line"></div>
            <div class="sign-name">${field(signatoryName)}</div>
            <div class="sign-title">${field(signatoryTitle)} · ${field(d.companyName)}</div>
          </div>
          <div class="sign-col">
            <p class="closing">Accepted and agreed,</p>
            <div class="sign-spacer"></div>
            <div class="sign-line"></div>
            <div class="sign-name">${field(d.candidateName)}</div>
            <div class="sign-title">Date: ____________________</div>
          </div>
        </div>
      </div>

      <div class="legal">
        This is a system-generated offer letter and is valid without a wet signature.
        Acceptance must be signed and returned by the offer validity date.
      </div>
    </div>
  </div>
</body>
</html>`;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LetterType =
  | "relieving"
  | "experience"
  | "internship"
  | "hike"
  | "promotion";

export interface InternshipDetails {
  startDate: string;
  endDate: string;
  designation: string;
}

export interface LetterRenderData {
  // Company
  companyName: string;
  companyAddress: string[];
  companyEmail: string;
  cinNo: string;
  iecCode: string;

  // Letter meta
  type: LetterType;
  issueDate: string; // "06 May 2026"
  reference?: string;

  // Employee
  employeeName: string;
  employeeNumber: string;
  designation: string;
  department: string;
  location: string;
  dateOfJoining: string;
  lastWorkingDay: string;

  // Internship period — optional prior-internship history on relieving /
  // experience letters; the primary subject of an "internship" letter.
  internship?: InternshipDetails;

  // Hike / promotion specifics.
  effectiveDate?: string;
  previousCtc?: number;
  newCtc?: number;
  previousDesignation?: string;
  newDesignation?: string;
  previousDepartment?: string;
  newDepartment?: string;

  // Body customisation (optional — sensible defaults derived if blank)
  salutation?: string;
  bodyParagraphs?: string[];
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
  if (!Number.isFinite(n) || !n) return "";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    n as number,
  );
};

function hikePercent(prev?: number, next?: number): number | null {
  if (!prev || !next || prev <= 0) return null;
  return Math.round(((next - prev) / prev) * 1000) / 10;
}

function headlineFor(type: LetterType): string {
  switch (type) {
    case "relieving":
      return "Relieving Letter";
    case "experience":
      return "Experience Letter";
    case "internship":
      return "Internship Experience Letter";
    case "hike":
      return "Salary Revision Letter";
    case "promotion":
      return "Letter of Promotion";
  }
}

function refPrefixFor(type: LetterType): string {
  switch (type) {
    case "relieving":
      return "REL";
    case "experience":
      return "EXP";
    case "internship":
      return "INTERN";
    case "hike":
      return "HIKE";
    case "promotion":
      return "PROMO";
  }
}

function defaultBody(d: LetterRenderData): string[] {
  const eName = escape(d.employeeName || "the employee");
  const eNum = d.employeeNumber
    ? ` (Employee No. ${escape(d.employeeNumber)})`
    : "";
  const company = escape(d.companyName || "the Company");
  const deptSeg = d.department
    ? ` in the ${escape(d.department)} department`
    : "";
  const locSeg = d.location
    ? `, based at our ${escape(d.location)} office`
    : "";
  const doj = d.dateOfJoining
    ? `<strong>${escape(d.dateOfJoining)}</strong>`
    : "the date of joining";
  const lwd = d.lastWorkingDay
    ? `<strong>${escape(d.lastWorkingDay)}</strong>`
    : "the date of separation";

  const internshipPara = buildInternshipParagraph(eName, d.internship);

  if (d.type === "relieving") {
    const roleClause = d.designation
      ? `, last holding the position of <strong>${escape(d.designation)}</strong>${deptSeg}${locSeg}`
      : "";
    const paras = [
      `This is to confirm that <strong>${eName}</strong>${eNum} has been relieved from the services of <strong>${company}</strong> with effect from the close of business on ${lwd}, pursuant to the acceptance of ${eName}'s resignation.`,
      `${eName} was associated with us from ${doj} to ${lwd}${roleClause}.`,
      `We confirm that all dues payable have been settled, and that company property, identification cards, and access credentials in ${eName}'s possession have been duly returned. The obligations of confidentiality and non-disclosure under the terms of employment continue to remain in effect.`,
      `We thank ${eName} for the contributions made during the tenure with us, and wish ${eName} the very best in all future endeavours.`,
    ];
    if (internshipPara) paras.splice(2, 0, internshipPara);
    return paras;
  }

  if (d.type === "experience") {
    const rolePara = d.designation
      ? `During the period of employment, ${eName} held the position of <strong>${escape(d.designation)}</strong>${deptSeg}${locSeg}.`
      : `${eName} was a valued member of our team during the period of employment.`;

    const paras = [
      `This is to certify that <strong>${eName}</strong>${eNum} was employed with <strong>${company}</strong> from ${doj} to ${lwd}.`,
      rolePara,
      `We found ${eName}'s conduct and performance during the tenure to be satisfactory. ${eName} carried out the responsibilities entrusted with sincerity and professionalism.`,
      `This certificate is issued upon request. We wish ${eName} continued success in all future endeavours.`,
    ];
    if (internshipPara) paras.splice(2, 0, internshipPara);
    return paras;
  }

  if (d.type === "internship") {
    // Certify the internship period drawn from the internship block, falling
    // back to the employee's main role / joining / last-working dates.
    const internRole = (d.internship?.designation || d.designation || "").trim();
    const internStart = (d.internship?.startDate || d.dateOfJoining || "").trim();
    const internEnd = (d.internship?.endDate || d.lastWorkingDay || "").trim();
    const startSeg = internStart
      ? `<strong>${escape(internStart)}</strong>`
      : "the start date";
    const endSeg = internEnd
      ? `<strong>${escape(internEnd)}</strong>`
      : "the end date";
    const internRoleClause = internRole
      ? ` in the capacity of <strong>${escape(internRole)}</strong>${deptSeg}${locSeg}`
      : "";

    return [
      `This is to certify that <strong>${eName}</strong>${eNum} successfully completed an internship with <strong>${company}</strong>${internRoleClause} from ${startSeg} to ${endSeg}.`,
      `During the internship, ${eName} was entrusted with assignments relevant to the role and carried them out with sincerity, demonstrating a strong willingness to learn and contribute to the team.`,
      `We found ${eName}'s conduct and performance throughout the internship period to be satisfactory.`,
      `This certificate is issued upon request. We wish ${eName} the very best in all future endeavours.`,
    ];
  }

  const eff = d.effectiveDate
    ? `<strong>${escape(d.effectiveDate)}</strong>`
    : "the effective date";
  const role = d.designation
    ? ` in your current role as <strong>${escape(d.designation)}</strong>${deptSeg}`
    : "";

  if (d.type === "hike") {
    const pct = hikePercent(d.previousCtc, d.newCtc);
    const newCtcSeg = d.newCtc
      ? `<strong>₹ ${escape(fmtINR(d.newCtc))}</strong> per annum`
      : "a revised annual compensation as detailed in the enclosed annexure";
    const prevCtcSeg = d.previousCtc
      ? ` from your previous annual compensation of <strong>₹ ${escape(fmtINR(d.previousCtc))}</strong>`
      : "";
    const pctSeg = pct !== null
      ? `, an increase of <strong>${escape(pct.toString())}%</strong>${prevCtcSeg}`
      : prevCtcSeg;

    return [
      `We are pleased to inform you that, in recognition of your performance, dedication, and valuable contribution to <strong>${company}</strong>${role}, your annual compensation has been revised with effect from ${eff}.`,
      `Your revised compensation will be ${newCtcSeg}${pctSeg}. The detailed compensation structure forms part of this letter and supersedes any prior arrangement.`,
      `All other terms and conditions of your employment, as set out in your appointment letter, remain unchanged. We look forward to your continued commitment and contribution.`,
      `On behalf of <strong>${company}</strong>, we thank you for your efforts and wish you continued success in your journey with us.`,
    ];
  }

  // promotion
  const prevDesig = d.previousDesignation || d.designation;
  const fromTo =
    prevDesig && d.newDesignation
      ? `from <strong>${escape(prevDesig)}</strong> to <strong>${escape(d.newDesignation)}</strong>`
      : d.newDesignation
      ? `to the position of <strong>${escape(d.newDesignation)}</strong>`
      : "to your new role";
  const deptChange =
    d.newDepartment && d.previousDepartment && d.newDepartment !== d.previousDepartment
      ? `, moving from the <strong>${escape(d.previousDepartment)}</strong> department to <strong>${escape(d.newDepartment)}</strong>`
      : d.newDepartment
      ? `, within the <strong>${escape(d.newDepartment)}</strong> department`
      : "";

  const ctcPara = d.newCtc
    ? `In line with this promotion, your annual compensation has also been revised to <strong>₹ ${escape(fmtINR(d.newCtc))}</strong> per annum, effective from the same date. The detailed compensation structure forms part of this letter.`
    : "";

  const paras = [
    `We are delighted to inform you that, based on your consistent performance, professional growth, and valuable contributions to <strong>${company}</strong>, you have been <strong>promoted</strong> ${fromTo}${deptChange}, with effect from ${eff}.`,
    `In your new role, you will be entrusted with greater responsibilities commensurate with this position. We trust you will continue to demonstrate the same level of commitment, leadership, and excellence that earned you this elevation.`,
  ];
  if (ctcPara) paras.push(ctcPara);
  paras.push(
    `All other terms and conditions of your employment, as set out in your appointment letter, remain unchanged. Kindly acknowledge receipt of this letter by signing the duplicate copy.`,
    `On behalf of <strong>${company}</strong>, we extend our heartfelt congratulations and wish you the very best in your new role.`,
  );
  return paras;
}

function buildInternshipParagraph(
  eName: string,
  intern: InternshipDetails | undefined
): string | null {
  if (!intern) return null;
  const start = intern.startDate?.trim();
  const end = intern.endDate?.trim();
  const role = intern.designation?.trim();
  if (!start && !end && !role) return null;
  const startSeg = start ? `<strong>${escape(start)}</strong>` : "the internship start date";
  const endSeg = end ? `<strong>${escape(end)}</strong>` : "the internship end date";
  const roleSeg = role ? ` as a <strong>${escape(role)}</strong>` : "";
  return `Prior to the full-time engagement, ${eName} interned with us${roleSeg} from ${startSeg} to ${endSeg}.`;
}

const issuedToday = () =>
  new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

interface SummaryRow {
  label: string;
  value: string;
  highlight?: boolean;
}

function buildSummaryRows(d: LetterRenderData): SummaryRow[] {
  if (d.type === "hike") {
    const pct = hikePercent(d.previousCtc, d.newCtc);
    return [
      { label: "Employee", value: `${field(d.employeeName)} · ${field(d.employeeNumber)}` },
      { label: "Designation", value: field(d.designation) },
      { label: "Effective from", value: field(d.effectiveDate) },
      ...(d.previousCtc
        ? [{ label: "Previous CTC", value: `₹ ${fmtINR(d.previousCtc)} p.a.` }]
        : []),
      ...(d.newCtc
        ? [
            {
              label: "Revised CTC",
              value: `₹ ${fmtINR(d.newCtc)} p.a.`,
              highlight: true,
            },
          ]
        : []),
      ...(pct !== null
        ? [{ label: "Increment", value: `${pct}%`, highlight: true }]
        : []),
    ];
  }
  if (d.type === "promotion") {
    return [
      { label: "Employee", value: `${field(d.employeeName)} · ${field(d.employeeNumber)}` },
      {
        label: "Previous role",
        value: field(d.previousDesignation || d.designation),
      },
      {
        label: "New role",
        value: field(d.newDesignation),
        highlight: true,
      },
      ...(d.previousDepartment || d.newDepartment
        ? [
            {
              label: "Department",
              value:
                d.newDepartment && d.previousDepartment &&
                d.previousDepartment !== d.newDepartment
                  ? `${field(d.previousDepartment)} → ${field(d.newDepartment)}`
                  : field(d.newDepartment || d.previousDepartment),
            },
          ]
        : []),
      { label: "Effective from", value: field(d.effectiveDate) },
      ...(d.newCtc
        ? [
            {
              label: "Revised CTC",
              value: `₹ ${fmtINR(d.newCtc)} p.a.`,
              highlight: true,
            },
          ]
        : []),
    ];
  }
  return [];
}

export function renderLetterHtml(d: LetterRenderData): string {
  const headline = headlineFor(d.type);
  const recipientLine =
    d.type === "experience" || d.type === "internship"
      ? `To Whom It May Concern,`
      : `Dear ${escape(d.employeeName || "Sir/Madam")},`;
  const refCode =
    d.reference ||
    `${refPrefixFor(d.type)}/${(d.employeeNumber || "EMP").toUpperCase()}/${(d.issueDate || issuedToday()).replace(/\s+/g, "-")
    }`;
  const issueDate = d.issueDate || issuedToday();
  const paragraphs =
    d.bodyParagraphs && d.bodyParagraphs.length > 0
      ? d.bodyParagraphs
      : defaultBody(d);
  const closing =
    d.closing ||
    (d.type === "relieving"
      ? "Yours sincerely,"
      : "For " + (d.companyName || "the company"));
  const signatoryName = d.signatoryName || "Santhosh Reddy Panyala";
  const signatoryTitle = d.signatoryTitle || "Human Resources";

  const summary = buildSummaryRows(d);
  const summaryHtml =
    summary.length > 0
      ? `<div class="summary">
            <div class="summary-title">At a glance</div>
            <div class="summary-grid">
              ${summary
                .map(
                  (r) => `
                <div class="summary-cell${r.highlight ? " is-highlight" : ""}">
                  <div class="summary-label">${escape(r.label)}</div>
                  <div class="summary-value">${r.value}</div>
                </div>
              `,
                )
                .join("")}
            </div>
          </div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escape(headline)} — ${escape(d.employeeName)}</title>
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
      --primary-soft: rgba(47, 117, 147, 0.08);
      --slate-50: #f8fafc;
      --slate-100: #f1f5f9;
      --emerald-50: #ecfdf5;
      --emerald-700: #047857;
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
    .sheet { page-break-inside: avoid; break-inside: avoid; }
    .legal { page-break-before: avoid; break-before: avoid; }
    .display {
      font-family: "Instrument Serif", "Cormorant Garamond", Georgia, serif;
      letter-spacing: -0.01em;
      font-weight: 400;
    }

    .page { padding: 2mm 0; }
    .sheet {
      width: 100%;
      margin: 0;
      background: #ffffff;
      overflow: hidden;
    }

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
      max-width: 340px;
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
      font-size: 26px;
      line-height: 1;
      color: var(--fg);
    }
    .brand-meta-line {
      margin-top: 6px;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--muted);
    }
    .ref-pill {
      display: inline-block;
      margin-top: 10px;
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--slate-100);
      color: var(--fg);
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
      font-size: 10px;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    /* Body */
    .body {
      padding: 14px 36px 10px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      font-size: 12.5px;
      line-height: 1.6;
      color: var(--fg);
    }
    .body p + p { margin-top: 2px; }

    .meta-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      font-size: 11px;
      color: var(--muted);
    }
    .meta-row strong {
      color: var(--fg);
      font-weight: 500;
    }

    h1.letter-headline {
      font-family: "Instrument Serif", Georgia, serif;
      font-size: 26px;
      line-height: 1.1;
      letter-spacing: -0.01em;
      margin: 2px 0 4px;
      color: var(--fg);
      text-align: center;
    }
    .underline {
      width: 64px;
      height: 2px;
      background: var(--primary);
      margin: 0 auto 4px;
    }

    .salutation {
      margin: 2px 0 0;
      font-size: 13px;
      font-weight: 500;
    }
    .body p {
      margin: 0;
    }
    .body p strong { font-weight: 600; }

    /* Summary card (hike / promotion) */
    .summary {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 14px 6px;
      background: var(--slate-50);
    }
    .summary-title {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--primary);
      margin-bottom: 4px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px 24px;
    }
    .summary-cell {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .summary-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted);
    }
    .summary-value {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--fg);
    }
    .summary-cell.is-highlight .summary-value {
      color: var(--emerald-700);
      font-weight: 600;
    }

    /* Closing + signature */
    .closing-block {
      margin-top: 2px;
    }
    .closing {
      font-size: 12.5px;
      margin: 0 0 2px;
    }
    .sign-stage {
      position: relative;
      width: 230px;
      height: 96px;
    }
    .stamp-frame {
      position: absolute;
      left: 60px;
      top: 0;
      width: 96px;
      height: 96px;
      overflow: hidden;
    }
    .stamp-frame img {
      position: absolute;
      width: 172px;
      height: auto;
      left: -38px;
      top: -98px;
      opacity: 0.92;
    }
    .signature {
      position: absolute;
      left: 0;
      top: 14px;
      height: 80px;
      width: 150px;
      object-fit: contain;
      z-index: 2;
    }
    .sign-line {
      width: 210px;
      height: 1px;
      background: rgba(15, 23, 42, 0.3);
      margin-top: 0;
    }
    .sign-name {
      margin-top: 2px;
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
    }
    .sign-title {
      font-size: 10.5px;
      color: var(--muted);
    }

    /* Footer */
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
      <!-- Brand strip -->
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

      <!-- Body -->
      <div class="body">
        <div class="meta-row">
          <div>Date: <strong>${field(issueDate)}</strong></div>
          <div>Ref: <strong>${field(refCode)}</strong></div>
        </div>

        <div>
          <div class="underline"></div>
          <h1 class="letter-headline">${escape(headline)}</h1>
        </div>

        <p class="salutation">${recipientLine}</p>

        ${summaryHtml}

        ${paragraphs.map((p) => `<p>${p}</p>`).join("")}

        <div class="closing-block">
          <p class="closing">${escape(closing)}</p>
          <div class="sign-stage">
            ${STAMP_DATA ? `<div class="stamp-frame"><img src="${STAMP_DATA}" alt="" /></div>` : ""}
            ${SIG_DATA ? `<img class="signature" src="${SIG_DATA}" alt="" />` : ""}
          </div>
          <div class="sign-line"></div>
          <div class="sign-name">${field(signatoryName)}</div>
          <div class="sign-title">${field(signatoryTitle)} · ${field(d.companyName)}</div>
        </div>
      </div>

      <!-- Footer -->
      <div class="legal">
        This is a system-generated letter and is valid without a wet signature.
      </div>
    </div>
  </div>
</body>
</html>`;
}

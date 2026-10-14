import type { Activity, ClientProject, Company, Epic, Sprint, Task } from '../../api/types'
import { addDays, MON } from '../../lib/dates'
import { apiMode } from '../../api/http/config'

/**
 * InvoiceMatch: Daco's accounts-payable app, a project Viljetech delivered.
 * The Clients portal shows it as a completed, live project, embeds the live
 * app, and turns feedback sent from the app into client bug tickets.
 * Data from the prototype's `Invoice Match.dc.html` and the IM_* constants in
 * `Clients.dc.html`.
 */

// ---------- the delivered project (Clients board data)

export const IM_EPIC_IDS = ['im1', 'im2']
/** Epic that bugs reported from the live app go to. */
export const IM_BUG_EPIC = 'im2'
/** The client company the project belongs to. */
export const IM_COMPANY = 'daco'
export const IM_NAME = 'InvoiceMatch'
export const IM_HOST = 'invoicematch.daco.no'
/** Where the live app opens inside the Clients portal. */
export const IM_BASE = '/clients/live/invoicematch'

/** The project's id in its company (Companies data); `?project=imp` opens it on the Clients page. */
export const IM_PROJECT_ID = 'imp'

/** Facts about the live app shown on the portal card and in the live app's header (not part of the company data). */
export const IM_LIVE = {
  uptime: '99.98%',
  version: '1.4.2',
  lastDeployed: '9 Oct',
}

/**
 * The project as Daco's client project in the Companies data: delivered on 28 Sep
 * (its due date), in Maintenance with a support agreement (6h of 10h left this month).
 * Team: 1 Rahul, 3 Chary, 2 Vivek.
 */
export const IM_PROJECT: ClientProject = {
  id: IM_PROJECT_ID,
  name: IM_NAME,
  desc: 'Matches supplier invoices against purchase orders and goods receipts, and routes exceptions for approval.',
  state: 'maint',
  pct: 100,
  start: '2026-08-03',
  due: '2026-09-28',
  team: ['1', '3', '2'],
  epics: [
    { id: 'im1', name: 'Matching engine', state: 'done', pct: 100, sprints: 2 },
    { id: 'im2', name: 'Review & reports', state: 'done', pct: 100, sprints: 2 },
  ],
  sup: { until: '2027-09-28', used: 4, quota: 10 },
}

export const IM_EPICS: Epic[] = [
  { id: 'im1', name: 'Matching engine', p: 0, desc: 'Three-way match of invoice, PO and goods receipt', goal: 'Match most invoices without a person.', story: '', criteria: [], target: '2026-09-14', inScope: [], outScope: [], reqs: [] },
  { id: 'im2', name: 'Review & reports', p: 2, desc: 'Exception review, approvals and reporting', goal: 'Clear exceptions in one place.', story: '', criteria: [], target: '2026-09-28', inScope: [], outScope: [], reqs: [] },
]

export const IM_SPRINTS: Sprint[] = [
  { id: 'ims1', epic: 'im1', name: 'Sprint 1', start: '2026-08-03', end: '2026-08-16', members: ['Rahul', 'Chary'], state: 'done', summary: 'Completed' },
  { id: 'ims2', epic: 'im1', name: 'Sprint 2', start: '2026-08-17', end: '2026-08-30', members: ['Rahul', 'Chary'], state: 'done', summary: 'Completed' },
  { id: 'ims3', epic: 'im2', name: 'Sprint 3', start: '2026-08-31', end: '2026-09-13', members: ['Chary', 'Vivek'], state: 'done', summary: 'Completed' },
  { id: 'ims4', epic: 'im2', name: 'Sprint 4', start: '2026-09-14', end: '2026-09-28', members: ['Vivek', 'Rahul'], state: 'done', summary: 'Completed' },
]

const IM_TASK_ROWS: [string, Task['type'], string, string, string, string][] = [
  ['Import invoices from the AP mailbox', 'Story', 'im1', 'ims1', 'Rahul', '2026-08-14'],
  ['Read PO numbers from PDF invoices', 'Task', 'im1', 'ims1', 'Chary', '2026-08-15'],
  ['Match invoice lines to PO lines', 'Story', 'im1', 'ims2', 'Rahul', '2026-08-28'],
  ['Price and quantity tolerance rules', 'Task', 'im1', 'ims2', 'Chary', '2026-08-29'],
  ['Goods receipt sync from the ERP', 'Task', 'im1', 'ims2', 'Rahul', '2026-08-30'],
  ['Invoice inbox with filters', 'Story', 'im2', 'ims3', 'Chary', '2026-09-10'],
  ['Match review screen', 'Story', 'im2', 'ims3', 'Vivek', '2026-09-12'],
  ['Approve, hold and reject actions', 'Task', 'im2', 'ims4', 'Vivek', '2026-09-20'],
  ['Reports and CSV export', 'Task', 'im2', 'ims4', 'Rahul', '2026-09-24'],
  ['Duplicate invoice check', 'Bug', 'im2', 'ims4', 'Chary', '2026-09-26'],
  ['Go-live and handover', 'Task', 'im2', 'ims4', 'Vivek', '2026-09-28'],
]

const hist = (who: string, what: string, when: string): Activity => ({ kind: 'history', who, what, when })

/** The project's delivered tickets, numbered from `firstId` (the prototype used 9000+, which would push every new ticket key past PMT-9000). */
export const imTasks = (firstId: number): Task[] =>
  IM_TASK_ROWS.map(([title, type, epic, sprint, assignee, due], k) => ({
    id: String(firstId + k),
    title,
    type,
    status: 'done',
    prio: k === 2 || k === 9 ? 'High' : 'Medium',
    due,
    assignee,
    contribs: [],
    est: '',
    desc: '',
    atts: [],
    subs: [],
    deps: [],
    acts: [hist(assignee, 'completed the task', 'Sep 2026')],
    epic,
    sprint,
    start: addDays(due, -5),
    time: {},
  }))

/** The board shows the InvoiceMatch project when every picked epic is one of its epics. */
export const isImSelection = (epSel: string[], ids: string[] = IM_EPIC_IDS) => epSel.length > 0 && epSel.every(id => ids.includes(id))

/**
 * Whether a project is the InvoiceMatch project: Daco's fixed project in mock mode;
 * in API mode, a real project named InvoiceMatch (under Aurora Foods on the Demo DB).
 */
export const isImProject = (p: Pick<ClientProject, 'id' | 'name'>) => p.id === IM_PROJECT_ID || (apiMode && p.name === IM_NAME)

/** Whether a client company has the InvoiceMatch project (read from its projects in the Companies data). */
export const hasInvoiceMatch = (company: Pick<Company, 'projects'> | undefined) => !!company && company.projects.some(isImProject)

/** The first company with the InvoiceMatch project, and that project. */
export const imProjectOf = (companies: Company[] | undefined) => {
  for (const company of companies ?? []) {
    const project = company.projects.find(isImProject)
    if (project) return { company, project }
  }
  return null
}

/** The project's epics (mock: the fixed ones; API mode without the project: none). */
export const imEpicIds = (p: Pick<ClientProject, 'epics'> | null | undefined): string[] =>
  p?.epics.length ? p.epics.map(e => e.id) : apiMode ? [] : IM_EPIC_IDS

/** The epic that bugs reported from the live app go to: "Review & reports", else the last one. */
export const imBugEpic = (p: Pick<ClientProject, 'epics'> | null | undefined): string =>
  p?.epics.find(e => e.name === 'Review & reports')?.id ?? p?.epics.at(-1)?.id ?? IM_BUG_EPIC

// ---------- the live app's data

/** [description, qty invoiced, qty ordered, qty received, invoice price, PO price] */
export type InvoiceLine = [string, number, number, number, number, number]

export type MatchStatus = 'auto' | 'approved' | 'approval' | 'price' | 'qty' | 'nopo' | 'hold' | 'rejected'

export interface InvoiceDecision {
  st: 'approved' | 'hold' | 'rejected'
  note: string
  by: string
}

export interface Invoice {
  no: string
  sup: string
  /** ISO date received. */
  date: string
  po: string
  /** Status the matching engine gave it on arrival. */
  st: MatchStatus
  lines: InvoiceLine[]
  /** A person's decision. Undo removes it and the invoice falls back to `st`. */
  decision?: InvoiceDecision
}

/** The live app's own data, stored in the shared db. */
export interface InvoiceMatchDb {
  invoices: Invoice[]
  /** Set once the project has been added to its company (migrate3), so a project removed later stays removed. */
  projectAdded?: boolean
}

export const INVOICES_SEED: Invoice[] = [
  { no: 'INV-20418', sup: 'Byggmax Proff AS', date: '2026-10-09', po: 'PO-7731', st: 'auto', lines: [['Plasterboard 12.5 mm', 120, 120, 120, 189, 189], ['Drywall screws, box', 40, 40, 40, 149, 149]] },
  { no: 'INV-20417', sup: 'Ahlsell Norge', date: '2026-10-09', po: 'PO-7725', st: 'price', lines: [['Copper pipe 15 mm, 5 m', 60, 60, 60, 312, 289], ['Press fittings, 15 mm', 200, 200, 200, 24, 24]] },
  { no: 'INV-20415', sup: 'Würth Norge', date: '2026-10-08', po: 'PO-7719', st: 'qty', lines: [['Anchor bolts M10', 500, 500, 450, 6.8, 6.8], ['Safety gloves, size 9', 80, 80, 80, 59, 59]] },
  { no: 'INV-20412', sup: 'Ramirent AS', date: '2026-10-08', po: '', st: 'nopo', lines: [['Scaffold rental, week 40', 1, 0, 0, 18400, 0]] },
  { no: 'INV-20410', sup: 'Optimera AS', date: '2026-10-07', po: 'PO-7702', st: 'auto', lines: [['Timber 48x198, 4.8 m', 90, 90, 90, 268, 268]] },
  { no: 'INV-20409', sup: 'Ahlsell Norge', date: '2026-10-07', po: 'PO-7698', st: 'approval', lines: [['Ventilation duct 160 mm', 40, 40, 40, 412, 412], ['Duct clamps', 80, 80, 80, 38, 38]] },
  { no: 'INV-20406', sup: 'Byggmax Proff AS', date: '2026-10-06', po: 'PO-7690', st: 'auto', lines: [['Insulation 200 mm, pack', 64, 64, 64, 529, 529]] },
  { no: 'INV-20403', sup: 'Elektroskandia', date: '2026-10-06', po: 'PO-7684', st: 'price', lines: [['Cable PFSP 3G2.5, 100 m', 12, 12, 12, 2190, 1990]] },
  { no: 'INV-20401', sup: 'Optimera AS', date: '2026-10-05', po: 'PO-7679', st: 'approval', lines: [['OSB board 18 mm', 150, 150, 150, 349, 349]] },
  { no: 'INV-20398', sup: 'Würth Norge', date: '2026-10-03', po: 'PO-7660', st: 'auto', lines: [['Wood screws 5x80, box', 60, 60, 60, 229, 229]] },
]

/** [label, background, ink, dot] */
export const STS: Record<MatchStatus, [string, string, string, string]> = {
  auto: ['Matched', '#DCFCE7', '#166534', '#16A34A'],
  approved: ['Approved', '#DCFCE7', '#166534', '#16A34A'],
  approval: ['Awaiting approval', '#DBEAFE', '#1E40AF', '#3B82F6'],
  price: ['Price mismatch', '#FEF3C7', '#92400E', '#F59E0B'],
  qty: ['Quantity mismatch', '#FEF3C7', '#92400E', '#F59E0B'],
  nopo: ['Missing PO', '#FEE2E2', '#991B1B', '#EF4444'],
  hold: ['On hold', '#F3F4F6', '#374151', '#9CA3AF'],
  rejected: ['Rejected', '#FEE2E2', '#991B1B', '#EF4444'],
}

/** Statuses that need a person ("Needs attention" also counts awaiting approval). */
export const EXC: MatchStatus[] = ['price', 'qty', 'nopo', 'approval']

export const stOf = (i: Invoice): MatchStatus => i.decision?.st ?? i.st

export const nok = (n: number) => 'NOK ' + Math.round(n).toLocaleString('nb-NO').replace(/\s/g, ' ')
export const shortDate = (iso: string) => {
  const [, m, d] = iso.split('-')
  return +d + ' ' + MON[+m - 1]
}
export const total = (i: Invoice) => i.lines.reduce((s, l) => s + l[1] * l[4], 0)

/** Auto-match rate by month, Jan to Sep 2026; October is computed from the approvals. */
export const MONTH_RATES = [78, 80, 79, 83, 82, 85, 84, 86, 85]

/** [supplier, exceptions, why] for the last 90 days. */
export const SUPPLIER_EXCEPTIONS: [string, number, string][] = [
  ['Ahlsell Norge', 9, 'price'],
  ['Elektroskandia', 6, 'price'],
  ['Würth Norge', 5, 'quantity'],
  ['Ramirent AS', 4, 'missing PO'],
  ['Optimera AS', 2, 'quantity'],
]

export const REPORT_KPIS = [
  { l: 'Matched this year', v: '2 184', s: '+12% vs 2025', sc: '#166534' },
  { l: 'Value matched', v: 'NOK 41.8 m', s: 'Since 1 Jan', sc: '#4B5563' },
  { l: 'Average time to approve', v: '1.6 days', s: 'Down from 6.2 days before go-live', sc: '#166534' },
  { l: 'Duplicate invoices caught', v: '17', s: 'NOK 212 400 not paid twice', sc: '#166534' },
]

import type { Company, InternalProject, ProjectRef } from '../types'
import { COMPANIES_SEED } from '../companies/seed'
import type { DevopsDb, DvLog, DvProject } from './types'

/**
 * The prototype's sample projects (DevOps Board v6). Dates the prototype
 * computed from its "today" (9 Oct 2026) are written out here.
 */

const NEXT_365 =
  'Once the required Microsoft 365 and Azure infrastructure details are received from the client, proceed with environment planning and infrastructure setup.'

const fmtAdded = (iso: string) => {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m, d] = iso.split('-')
  return `${d} ${MON[+m - 1]} ${y}`
}

type SeedProject = Omit<DvProject, 'logs' | 'kind' | 'overdue' | 'updatedBy' | 'project'> & {
  logs?: DvLog[]
  overdue?: boolean
  updatedBy?: string
}

const client = (companyId: string, id: string): ProjectRef => ({ kind: 'client', companyId, id })

/** The project each sample DevOps item is (client projects in api/companies/seed.ts). */
export const DEVOPS_PROJECT_LINKS: Record<string, ProjectRef> = {
  'OPS-101': client('daco', 'dacop'),
  'OPS-102': client('inoff', 'inoffp'),
  'OPS-103': client('weland', 'welp'),
  'OPS-104': client('alnarp', 'alnp1'),
  'OPS-105': client('alnarp', 'alnp2'),
  'OPS-106': client('arc', 'arcp'),
  'OPS-107': client('fatech', 'fatp'),
  'OPS-108': client('osby', 'osbyp'),
  'OPS-109': client('redare', 'redp'),
  'OPS-110': client('sst', 'sstp'),
  'OPS-111': client('tryggratt', 'trygp'),
}

const DEV = { from: 'Development team', prio: 'Not set', act: 'Not required', step: null }

const P: SeedProject[] = [
  {
    key: 'OPS-101', name: 'Daco platform', infra: 'Not started', from: 'Not set', prio: 'Medium', act: 'Not required', step: null,
    phase: 'Kickoff email drafted. Onboarding starts once the client confirms the contact person.',
    deploy: 'Waiting', dev: 'Not set', owner: 'Chary', added: '2026-10-04',
  },
  {
    key: 'OPS-102', name: 'Intranet', infra: 'Client onboarding', from: 'Client', prio: 'High', act: 'Reminder 1', step: 1,
    seqStart: '2026-10-03T07:00',
    phase: 'Following up with the client for Azure environment onboarding.',
    logs: [{ type: 'Action update', by: 'Rahul', when: '2 d ago', text: 'First reminder sent asking for the Azure and Microsoft 365 tenant details.' }],
    notes: { 1: { text: 'First reminder sent asking for the Azure and Microsoft 365 tenant details.', when: '2 d ago' } },
    actDate: '2026-10-05T07:00', reminder: '2026-10-12T07:00', overdue: false, initDue: '2026-11-30',
    deploy: 'Waiting', dev: 'Not set', owner: 'Vivek', next: NEXT_365, added: '2026-10-01',
  },
  {
    key: 'OPS-103', name: 'Order portal', infra: 'Client onboarding', from: 'Client', prio: 'Critical', act: 'Inform Marcus', step: 4,
    seqStart: '2026-09-30T07:00',
    phase: 'Internal deployment is complete. Follow up with the client regarding the previously sent email and await their response.',
    logs: [{ type: 'Action update', by: 'Rahul', when: '3 d ago', text: 'No reply after the call. Marcus informed.' }],
    notes: { 4: { text: 'No reply after the call. Marcus informed.', when: '3 d ago' } },
    actDate: '2026-10-06T07:00', reminder: '2026-10-07T07:00', overdue: true, initDue: '2026-10-31', latestDue: '2026-11-20',
    moved: '+20 d', reason: 'No response from client', deploy: 'Waiting', dev: 'Not set', owner: 'Chary', added: '2026-09-28',
  },
  {
    ...DEV, key: 'OPS-104', cicd: true, name: 'Customer portal', infra: 'Deployment Completed', from: 'DevOps',
    deploy: 'Completed', initDue: '2026-09-15',
    next: "Infrastructure changes will be implemented based on the development team's updates, and the environment will be prepared for deployment.",
    dev: 'Production', owner: 'Raj', added: '2026-09-25',
  },
  {
    ...DEV, key: 'OPS-105', cicd: true, name: 'Lead automation', infra: 'Adding new services', prio: 'Medium',
    deploy: 'Completed', initDue: '2026-12-15',
    ifu: [
      { date: '2026-10-02', name: 'Waiting for dev team', done: true, note: 'Asked dev team for the new service list.' },
      { date: '2026-10-14', name: 'Follow-up 1' },
    ],
    reminder: '2026-10-14T07:00', overdue: false,
    next: 'Review the upcoming feature requirements once received from the development team, implement any necessary infrastructure changes, and…',
    dev: 'Development', owner: 'Raj', added: '2026-09-22',
  },
  {
    ...DEV, key: 'OPS-106', cicd: true, name: 'Fast', infra: 'Prod product deployment', prio: 'High',
    deploy: 'Waiting', initDue: '2026-10-30',
    ifu: [{ date: '2026-10-08', name: 'Waiting for dev team' }],
    reminder: '2026-10-08T07:00', overdue: true,
    next: "Waiting for the Developers Update. Any necessary changes will be implemented based on the feedback received.",
    dev: 'Client validation', owner: 'Ganesh', added: '2026-09-19',
    deploys: {
      first: '2026-09-28',
      rel: [
        // The prototype brings 2.6.2 in live while the Tickets page is open; here it is part of the data.
        { v: '2.6.2', name: 'Bug fixes for ticket import', st: 'Live', when: '2026-10-10T11:40' },
        // The prototype shows this one as "Today"; it is kept on the app's today (10 Oct).
        { v: '2.6.1', name: 'Ticket import and BankID login', st: 'Live', when: '2026-10-10T10:20' },
        { v: '2.6.0', name: 'Push notifications', st: 'Live', when: '2026-10-09T13:12' },
        { v: '2.5.3', name: 'Profile settings', st: 'Rolled back', when: '2026-10-08T16:40', note: 'Rolled back to 2.5.2' },
        { v: '2.5.2', name: 'Performance fixes', st: 'Live', when: '2026-10-06T10:05' },
        { v: '1.0.0', name: 'First go-live', st: 'Live', when: '2026-09-28T09:00' },
      ],
    },
  },
  {
    ...DEV, key: 'OPS-107', name: 'Website', infra: 'Dev project deployment', from: 'DevOps', prio: 'Low',
    deploy: 'Waiting', initDue: '2026-11-15',
    next: 'The VM is ready as per the requirement and will be changed according to the next phase of development.',
    dev: 'Development', owner: 'Ganesh', added: '2026-09-16',
  },
  {
    ...DEV, key: 'OPS-108', name: 'Webshop', infra: 'Internally deployment', prio: 'Medium', deploy: 'Waiting', initDue: '2026-11-20',
    ifu: [
      { date: '2026-09-25', name: 'Waiting for dev team', done: true, note: 'Dev team still finishing the API.' },
      { date: '2026-10-02', name: 'Follow-up 1', done: true, note: 'Two more days needed for testing.' },
      { date: '2026-10-16', name: 'Follow-up 2' },
    ],
    reminder: '2026-10-16T07:00', overdue: false,
    next: "Waiting for the development team to complete the project. Infrastructure changes will be initiated if required based on the development team's needs.",
    dev: 'Testing', owner: 'Ganesh', added: '2026-09-13',
  },
  {
    key: 'OPS-109', name: 'Booking platform', infra: 'Client onboarding', from: 'Client', prio: 'Medium', act: 'Waiting for client', step: 0,
    seqStart: '2026-10-09T07:00',
    phase: 'Onboarding email sent with the infrastructure checklist.',
    logs: [{ type: 'Action update', by: 'Rahul', when: 'Today', text: 'Onboarding started and checklist sent to the client.' }],
    notes: { 0: { text: 'Onboarding started and checklist sent to the client.', when: 'Today' } },
    actDate: '2026-10-09T07:00', reminder: '2026-10-12T07:00', overdue: false, initDue: '2026-12-15',
    deploy: 'Waiting', dev: 'Not set', owner: 'Vivek', added: '2026-09-10',
  },
  { ...DEV, key: 'OPS-110', name: 'Member portal', infra: 'Not started', from: 'Not set', deploy: 'Waiting', dev: 'Not set', owner: null, added: '2026-09-07' },
  {
    ...DEV, key: 'OPS-111', cicd: true, name: 'Case app', infra: 'Deployment Completed', from: 'DevOps', deploy: 'Completed',
    initDue: '2026-09-01',
    next: "Infrastructure changes will follow the client's requirements as future development phases progress.",
    dev: 'Production', owner: null, added: '2026-09-04',
  },
]

export const createDevopsSeed = (): DevopsDb => ({
  projects: P.map(p => {
    const by = p.updatedBy || 'Rahul'
    const project = DEVOPS_PROJECT_LINKS[p.key] ?? null
    return {
      ...p,
      project,
      kind: project?.kind ?? 'client',
      overdue: !!p.overdue,
      updatedBy: by,
      logs: [
        ...(p.logs || []),
        { type: 'Action', text: 'Project added', detail: 'Status: Not started', when: fmtAdded(p.added), by },
      ],
    }
  }),
  settings: {
    ladder: [
      { name: 'Waiting for client', hours: 0 },
      { name: 'Reminder 1', hours: 48 },
      { name: 'Reminder 2', hours: 24 },
      { name: 'Reminder 3', hours: 48 },
      { name: 'Inform Marcus', hours: 24 },
      { name: 'Escalate', hours: 24 },
    ],
    iladder: ['Waiting for dev team', 'Follow-up 1', 'Follow-up 2', 'Inform team lead', 'Escalate'],
    statuses: [
      'Not started',
      'Client onboarding',
      'Dev project deployment',
      'Prod product deployment',
      'Deployment Completed',
      'Internally deployment',
      'Adding new services',
    ].map(name => ({ name, desc: '' })),
    devPhases: [
      { name: 'Not started', days: null },
      { name: 'Development', days: 30 },
      { name: 'Testing', days: 14 },
      { name: 'Client validation', days: 10 },
      { name: 'Production', days: 0 },
    ],
    rules: {
      esc: 4,
      escStep: 'Inform Marcus',
      requireNote: true,
      requireReminder: true,
      lockInitial: true,
      requirePhaseDue: true,
      remTime: '07:00',
      requireDevDue: true,
      lockDevDue: true,
    },
    options: {},
    people: ['Chary', 'Vivek', 'Raj', 'Ganesh', 'Rahul'],
  },
})

/** Project names before the v4 design split them into client and project name. */
const OLD_NAMES: Record<string, string> = {
  'OPS-101': 'DACO', 'OPS-102': 'Inoff', 'OPS-103': 'Weland', 'OPS-104': 'Alnarp Customer portal',
  'OPS-105': 'Alnarp Lead Automation', 'OPS-106': 'ARC Fast', 'OPS-107': 'Fa tech', 'OPS-108': 'OSBY',
  'OPS-109': 'Redare', 'OPS-110': 'SST', 'OPS-111': 'Tryggrätt',
}

/**
 * Brings DevOps data saved before the v4 design up to date: sample projects still
 * under their old name get the new name and the sample release history, and
 * requests on them take the new project name. Anything else is kept.
 */
export const upgradeDevopsNames = <R extends { key: string; pname: string }>(dv: DevopsDb, requests: R[]) => {
  const seed = new Map(P.map(p => [p.key, p]))
  const renamed = new Map<string, string>()
  const projects = (dv.projects as StoredItem[]).map(p => {
    const s = seed.get(p.key)
    if (p.client !== undefined || p.project !== undefined || !s || OLD_NAMES[p.key] !== p.name) return p
    renamed.set(p.key, s.name)
    return { ...p, name: s.name, ...(s.deploys && !p.deploys ? { deploys: s.deploys } : {}) }
  })
  if (!renamed.size) return { devops: dv, requests }
  return {
    devops: { ...dv, projects: projects as DvProject[] },
    requests: requests.map(r => (renamed.has(r.key) && r.pname === OLD_NAMES[r.key] ? { ...r, pname: renamed.get(r.key) as string } : r)),
  }
}

/** A DevOps item as stored before v5: a client name instead of a project link. */
type StoredItem = Omit<DvProject, 'project'> & { project?: ProjectRef | null; client?: string }

/**
 * v5: every DevOps item is a project. Gives items saved before v5 their `project` link:
 * - a sample item (key and name as seeded) links to its sample project; when the store has no such
 *   project yet, the project (and its company, if missing) is added from the seed;
 * - any other item links to the client project of the same name (its old client's first), or else
 *   the internal project of that name;
 * - an item with no match keeps its data and its client name, with `project: null`.
 * Returns the same objects when nothing changes.
 */
export const linkDevopsProjects = (dv: DevopsDb, companies: Company[], internal: InternalProject[]) => {
  const seedNames = new Map(P.map(p => [p.key, p.name]))
  let cos = companies
  let changed = false
  const ensure = (ref: Extract<ProjectRef, { kind: 'client' }>): boolean => {
    const co = cos.find(c => c.id === ref.companyId)
    if (co?.projects.some(x => x.id === ref.id)) return true
    const seedCo = COMPANIES_SEED.find(c => c.id === ref.companyId)
    const seedProject = seedCo?.projects.find(x => x.id === ref.id)
    if (!seedProject) return false
    cos = co
      ? cos.map(c => (c === co ? { ...c, projects: [...c.projects, structuredClone(seedProject)] } : c))
      : [...cos, { ...structuredClone(seedCo as Company), projects: [structuredClone(seedProject)] }]
    return true
  }
  const projects = (dv.projects as StoredItem[]).map((p): DvProject => {
    if (p.project !== undefined) return p as DvProject
    changed = true
    let ref: ProjectRef | null = null
    const seeded = DEVOPS_PROJECT_LINKS[p.key]
    if (seeded && seedNames.get(p.key) === p.name && seeded.kind === 'client' && ensure(seeded)) ref = seeded
    if (!ref) {
      const named = cos.flatMap(c => c.projects.filter(x => x.name === p.name).map(x => ({ c, x })))
      const hit = named.find(h => h.c.name === p.client) || named[0]
      if (hit) ref = { kind: 'client', companyId: hit.c.id, id: hit.x.id }
      else {
        const ip = internal.find(x => x.name === p.name)
        if (ip) ref = { kind: 'internal', id: ip.id }
      }
    }
    if (!ref) return { ...p, project: null }
    const { client: _client, ...rest } = p
    void _client
    return { ...rest, project: ref, kind: ref.kind }
  })
  if (!changed) return { devops: dv, companies }
  return { devops: { ...dv, projects }, companies: cos }
}

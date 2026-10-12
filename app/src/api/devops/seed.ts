import type { DevopsDb, DvLog, DvProject } from './types'
import { SEED_RELEASES } from './releases'

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

type SeedProject = Omit<DvProject, 'logs' | 'kind' | 'overdue' | 'updatedBy'> & {
  logs?: DvLog[]
  overdue?: boolean
  updatedBy?: string
}

const DEV = { from: 'Development team', prio: 'Not set', act: 'Not required', step: null }

const P: SeedProject[] = [
  {
    key: 'OPS-101', name: 'DACO', infra: 'Not started', from: 'Not set', prio: 'Medium', act: 'Not required', step: null,
    phase: 'Kickoff email drafted. Onboarding starts once the client confirms the contact person.',
    deploy: 'Waiting', dev: 'Not set', owner: 'Chary', added: '2026-10-04',
  },
  {
    key: 'OPS-102', name: 'Inoff', infra: 'Client onboarding', from: 'Client', prio: 'High', act: 'Reminder 1', step: 1,
    seqStart: '2026-10-03T07:00',
    phase: 'Following up with the client for Azure environment onboarding.',
    logs: [{ type: 'Action update', by: 'Rahul', when: '2 d ago', text: 'First reminder sent asking for the Azure and Microsoft 365 tenant details.' }],
    notes: { 1: { text: 'First reminder sent asking for the Azure and Microsoft 365 tenant details.', when: '2 d ago' } },
    actDate: '2026-10-05T07:00', reminder: '2026-10-12T07:00', overdue: false, initDue: '2026-11-30',
    deploy: 'Waiting', dev: 'Not set', owner: 'Vivek', next: NEXT_365, added: '2026-10-01',
  },
  {
    key: 'OPS-103', name: 'Weland', infra: 'Client onboarding', from: 'Client', prio: 'Critical', act: 'Inform Marcus', step: 4,
    seqStart: '2026-09-30T07:00',
    phase: 'Internal deployment is complete. Follow up with the client regarding the previously sent email and await their response.',
    logs: [{ type: 'Action update', by: 'Rahul', when: '3 d ago', text: 'No reply after the call. Marcus informed.' }],
    notes: { 4: { text: 'No reply after the call. Marcus informed.', when: '3 d ago' } },
    actDate: '2026-10-06T07:00', reminder: '2026-10-07T07:00', overdue: true, initDue: '2026-10-31', latestDue: '2026-11-20',
    moved: '+20 d', reason: 'No response from client', deploy: 'Waiting', dev: 'Not set', owner: 'Chary', added: '2026-09-28',
  },
  {
    ...DEV, key: 'OPS-104', cicd: true, name: 'Alnarp Customer portal', infra: 'Deployment Completed', from: 'DevOps',
    deploy: 'Completed', initDue: '2026-09-15',
    next: "Infrastructure changes will be implemented based on the development team's updates, and the environment will be prepared for deployment.",
    dev: 'Production', owner: 'Raj', added: '2026-09-25',
  },
  {
    ...DEV, key: 'OPS-105', cicd: true, name: 'Alnarp Lead Automation', infra: 'Adding new services', prio: 'Medium',
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
    ...DEV, key: 'OPS-106', cicd: true, name: 'ARC Fast', infra: 'Prod product deployment', prio: 'High',
    deploy: 'Waiting', initDue: '2026-10-30',
    ifu: [{ date: '2026-10-08', name: 'Waiting for dev team' }],
    reminder: '2026-10-08T07:00', overdue: true,
    next: "Waiting for the Developers Update. Any necessary changes will be implemented based on the feedback received.",
    dev: 'Client validation', owner: 'Ganesh', added: '2026-09-19',
  },
  {
    ...DEV, key: 'OPS-107', name: 'Fa tech', infra: 'Dev project deployment', from: 'DevOps', prio: 'Low',
    deploy: 'Waiting', initDue: '2026-11-15',
    next: 'The VM is ready as per the requirement and will be changed according to the next phase of development.',
    dev: 'Development', owner: 'Ganesh', added: '2026-09-16',
  },
  {
    ...DEV, key: 'OPS-108', name: 'OSBY', infra: 'Internally deployment', prio: 'Medium', deploy: 'Waiting', initDue: '2026-11-20',
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
    key: 'OPS-109', name: 'Redare', infra: 'Client onboarding', from: 'Client', prio: 'Medium', act: 'Waiting for client', step: 0,
    seqStart: '2026-10-09T07:00',
    phase: 'Onboarding email sent with the infrastructure checklist.',
    logs: [{ type: 'Action update', by: 'Rahul', when: 'Today', text: 'Onboarding started and checklist sent to the client.' }],
    notes: { 0: { text: 'Onboarding started and checklist sent to the client.', when: 'Today' } },
    actDate: '2026-10-09T07:00', reminder: '2026-10-12T07:00', overdue: false, initDue: '2026-12-15',
    deploy: 'Waiting', dev: 'Not set', owner: 'Vivek', added: '2026-09-10',
  },
  { ...DEV, key: 'OPS-110', name: 'SST', infra: 'Not started', from: 'Not set', deploy: 'Waiting', dev: 'Not set', owner: null, added: '2026-09-07' },
  {
    ...DEV, key: 'OPS-111', cicd: true, name: 'Tryggrätt', infra: 'Deployment Completed', from: 'DevOps', deploy: 'Completed',
    initDue: '2026-09-01',
    next: "Infrastructure changes will follow the client's requirements as future development phases progress.",
    dev: 'Production', owner: null, added: '2026-09-04',
  },
]

export const createDevopsSeed = (): DevopsDb => ({
  projects: P.map(p => {
    const by = p.updatedBy || 'Rahul'
    return {
      ...p,
      ...(SEED_RELEASES[p.key] ? { releases: SEED_RELEASES[p.key] } : {}),
      kind: 'client',
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

import type { Company, Epic, Project } from '../types';

/**
 * Companies (v5 `CO0`, web ids) plus the DevOps clients (A-5, DECISIONS 3): every
 * DevOps record links to a project, so Inoff, Weland, Alnarp, ARC, Fa tech, OSBY,
 * Redare, SST and Tryggrätt are seeded as companies with one project each. They have
 * no media logo and get initials tiles.
 */
export const COMPANIES: Company[] = [
  {
    id: 'daco', name: 'Daco', industry: 'Construction services', country: 'Norway', web: 'daco.no', p: 0,
    notes: 'Long-term client. We build their customer platform: a mobile app for their clients and a web tool for their project managers.',
    ourRoles: { Rahul: 'Super admin', Chary: 'Developer', 'Bhavana P': 'Developer', Vivek: 'Admin' },
    contacts: [
      { name: 'Ingrid Solberg', role: 'CTO', email: 'ingrid@daco.no', projects: ['dacop'], admin: true },
      { name: 'Lars Moen', role: 'Product owner', email: 'lars@daco.no', projects: ['dacop'] },
    ],
    archived: false,
  },
  {
    id: 'nord', name: 'Nordlys Energi', industry: 'Energy', country: 'Norway', web: 'nordlys.no', p: 1,
    notes: 'Self-service portal for business customers.', ourRoles: {},
    contacts: [{ name: 'Kari Berg', role: 'Head of digital', email: 'kari@nordlys.no', projects: ['nordp'], admin: true }],
    archived: false,
  },
  { id: 'fjord', name: 'Fjordline Logistics', industry: 'Logistics', country: 'Sweden', web: '', p: 2, notes: '', ourRoles: {}, contacts: [], archived: false },
  {
    id: 'hav', name: 'Havbruk AS', industry: 'Aquaculture', country: 'Norway', web: '', p: 3, notes: 'New client, kickoff in November.', ourRoles: {},
    contacts: [{ name: 'Ola Nilsen', role: 'CEO', email: 'ola@havbruk.no', projects: [] }],
    archived: false,
  },
  // DevOps clients (A-5)
  { id: 'inoff', name: 'Inoff', industry: 'Office services', country: 'Sweden', web: 'inoff.se', p: 4, notes: 'Intranet on Microsoft 365 and Azure.', ourRoles: {}, contacts: [], archived: false },
  { id: 'weland', name: 'Weland', industry: 'Manufacturing', country: 'Sweden', web: 'weland.se', p: 5, notes: '', ourRoles: {}, contacts: [], archived: false },
  { id: 'alnarp', name: 'Alnarp', industry: 'Agriculture', country: 'Sweden', web: 'alnarp.se', p: 0, notes: '', ourRoles: {}, contacts: [], archived: false },
  { id: 'arc', name: 'ARC', industry: 'Logistics', country: 'Norway', web: 'arc.no', p: 1, notes: '', ourRoles: {}, contacts: [], archived: false },
  { id: 'fatech', name: 'Fa tech', industry: 'Technology', country: 'India', web: 'fatech.in', p: 2, notes: '', ourRoles: {}, contacts: [], archived: false },
  { id: 'osby', name: 'OSBY', industry: 'Retail', country: 'Sweden', web: 'osby.se', p: 3, notes: '', ourRoles: {}, contacts: [], archived: false },
  { id: 'redare', name: 'Redare', industry: 'Shipping', country: 'Norway', web: 'redare.no', p: 4, notes: '', ourRoles: {}, contacts: [], archived: false },
  { id: 'sst', name: 'SST', industry: 'Associations', country: 'Sweden', web: 'sst.se', p: 5, notes: '', ourRoles: {}, contacts: [], archived: false },
  { id: 'tryggratt', name: 'Tryggrätt', industry: 'Legal services', country: 'Sweden', web: 'tryggratt.se', p: 0, notes: '', ourRoles: {}, contacts: [], archived: false },
];

/** Client projects (v5 `CO0[].projects`) and internal projects (`INT0`), flat. */
export const PROJECTS: Project[] = [
  {
    id: 'dacop', kind: 'client', companyId: 'daco', name: 'Daco platform', desc: 'Customer app and project management tool', state: 'active', pct: 22,
    start: '2026-09-01', due: '2026-12-20', team: ['Rahul', 'Chary', 'Bhavana P', 'Vivek', 'Sofia'], keyPrefix: 'PMT',
  },
  {
    id: 'nordp', kind: 'client', companyId: 'nord', name: 'Business portal', desc: 'Usage dashboard and billing for business customers', state: 'active', pct: 41,
    start: '2026-08-15', due: '2026-10-08', team: ['Chary', 'Bhavana P'], keyPrefix: 'NRD',
  },
  {
    id: 'fjp', kind: 'client', companyId: 'fjord', name: 'Driver app', desc: 'Route planning and proof of delivery', state: 'maint', pct: 100,
    start: '2026-03-01', due: '2026-08-30', sup: { until: '2027-08-30', used: 6, quota: 10 }, team: ['Vivek'], keyPrefix: 'FJD',
  },
  // DevOps-linked client projects (A-5)
  { id: 'inoffi', kind: 'client', companyId: 'inoff', name: 'Intranet', desc: 'Intranet on Microsoft 365', state: 'active', pct: 15, start: '2026-09-15', due: '2026-11-30', team: ['Vivek'], keyPrefix: 'INO' },
  { id: 'welop', kind: 'client', companyId: 'weland', name: 'Order portal', desc: 'Ordering portal for dealers', state: 'active', pct: 80, start: '2026-06-01', due: '2026-10-31', team: ['Chary'], keyPrefix: 'WOP' },
  { id: 'alncp', kind: 'client', companyId: 'alnarp', name: 'Customer portal', desc: 'Self-service portal for growers', state: 'done', pct: 100, start: '2026-03-01', due: '2026-09-15', team: ['Vivek'], keyPrefix: 'ACP' },
  { id: 'alnla', kind: 'client', companyId: 'alnarp', name: 'Lead automation', desc: 'Lead scoring and follow-up automation', state: 'active', pct: 45, start: '2026-08-01', due: '2026-12-15', team: ['Vivek'], keyPrefix: 'ALA' },
  { id: 'arcf', kind: 'client', companyId: 'arc', name: 'Fast', desc: 'Freight booking and tracking', state: 'active', pct: 90, start: '2026-04-01', due: '2026-10-30', team: ['Rahul'], keyPrefix: 'FST' },
  { id: 'fatw', kind: 'client', companyId: 'fatech', name: 'Website', desc: 'Company website and blog', state: 'active', pct: 35, start: '2026-09-01', due: '2026-11-15', team: ['Sofia'], keyPrefix: 'FTW' },
  { id: 'osbyw', kind: 'client', companyId: 'osby', name: 'Webshop', desc: 'B2C webshop', state: 'active', pct: 70, start: '2026-06-15', due: '2026-11-20', team: ['Chary'], keyPrefix: 'OSW' },
  { id: 'redbp', kind: 'client', companyId: 'redare', name: 'Booking platform', desc: 'Berth booking for ship owners', state: 'planned', pct: 0, start: '2026-11-02', due: '2026-12-15', team: ['Vivek'], keyPrefix: 'RBP' },
  { id: 'sstmp', kind: 'client', companyId: 'sst', name: 'Member portal', desc: 'Member registry and payments', state: 'planned', pct: 0, start: '2026-12-01', due: '2027-03-31', team: [], keyPrefix: 'SMP' },
  { id: 'trca', kind: 'client', companyId: 'tryggratt', name: 'Case app', desc: 'Case handling app for lawyers', state: 'done', pct: 100, start: '2026-02-01', due: '2026-09-01', team: ['Rahul'], keyPrefix: 'TCA' },
  // Internal projects (INT0); i1 uses INT, never OPS (A-13)
  { id: 'i1', kind: 'internal', area: 'Platform & tooling', name: 'DevOps board', desc: 'Internal board for infra status, phases and follow-ups', state: 'active', pct: 70, due: '2026-10-31', team: ['Rahul', 'Vivek'], keyPrefix: 'INT' },
  { id: 'i2', kind: 'internal', area: 'Website & marketing', name: 'Viljetech website', desc: 'New marketing site and case studies', state: 'planned', pct: 0, start: '2026-11-03', due: '2026-12-15', team: ['Bhavana P', 'Chary', 'Sofia'], keyPrefix: 'VW' },
  { id: 'i3', kind: 'internal', area: 'Infrastructure', name: 'Shared CI/CD templates', desc: 'Reusable pipelines for client projects', state: 'done', pct: 100, due: '2026-09-20', team: ['Vivek'], keyPrefix: 'CIT' },
];

/** Epics (web `EpicSummary` + projectId). Internal projects use a pseudo-epic (selector). */
export const EPICS: Epic[] = [
  { id: 'mob', projectId: 'dacop', name: 'Mobile app', state: 'active', pct: 9, sprints: 8 },
  { id: 'web', projectId: 'dacop', name: 'Web app', state: 'active', pct: 35, sprints: 2 },
  { id: 'n1', projectId: 'nordp', name: 'Metering dashboard', state: 'active', pct: 62, sprints: 4 },
  { id: 'n2', projectId: 'nordp', name: 'Billing API', state: 'planned', pct: 0, sprints: 0 },
  { id: 'f1', projectId: 'fjp', name: 'Route planning', state: 'done', pct: 100, sprints: 3 },
  { id: 'f2', projectId: 'fjp', name: 'Proof of delivery', state: 'done', pct: 100, sprints: 2 },
];

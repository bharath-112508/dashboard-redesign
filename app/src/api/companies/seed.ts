import type { ClientProject, Company } from '../types'
import { DRIVER_APP_SUPPORT } from '../projects/seed'
import { IM_PROJECT } from '../../features/invoice-match/data'

/**
 * Client companies, from the prototype's Companies seed (CO0). The Projects
 * page's variant (which adds Sofia to Daco platform) is not used; see the README.
 */
export const COMPANIES_SEED: Company[] = [
  {
    id: 'daco', name: 'Daco', industry: 'Construction services', country: 'Norway', web: 'daco.no', p: 0,
    notes: 'Long-term client. Mobile and web platform for field teams.',
    contacts: [
      { personId: 7, name: 'Ingrid Solberg', role: 'CTO', email: 'ingrid@daco.no', projects: ['dacop'], admin: true },
      { personId: 8, name: 'Lars Moen', role: 'Product owner', email: 'lars@daco.no', projects: ['dacop'] },
    ],
    projects: [
      {
        id: 'dacop', name: 'Daco platform', desc: 'Mobile app and web platform for Daco customers.', state: 'active', pct: 22,
        due: '2026-12-20', team: [1, 3, 4, 2],
        epics: [
          { id: 'mob', name: 'Mobile app', state: 'active', pct: 9, sprints: 8 },
          { id: 'web', name: 'Web app', state: 'active', pct: 35, sprints: 2 },
        ],
      },
      // v5: the delivered InvoiceMatch app (features/invoice-match), live and in Maintenance.
      structuredClone(IM_PROJECT),
    ],
    ourRoles: { 1: 'Super admin', 2: 'Admin', 3: 'Developer', 4: 'Developer' },
    archived: false, archivedAt: null,
  },
  {
    id: 'nord', name: 'Nordlys Energi', industry: 'Energy', country: 'Norway', web: 'nordlys.no', p: 1,
    notes: '', contacts: [{ personId: 9, name: 'Kari Berg', role: 'Head of digital', email: 'kari@nordlys.no', projects: ['nordp'] }],
    projects: [
      {
        id: 'nordp', name: 'Business portal', desc: 'Customer portal for metering and billing.', state: 'active', pct: 41,
        due: '2026-10-08', team: [3, 4],
        epics: [
          { id: 'n1', name: 'Metering dashboard', state: 'active', pct: 62, sprints: 4 },
          { id: 'n2', name: 'Billing API', state: 'planned', pct: 0, sprints: 0 },
        ],
      },
    ],
    ourRoles: {}, archived: false, archivedAt: null,
  },
  {
    id: 'fjord', name: 'Fjordline Logistics', industry: 'Logistics', country: 'Sweden', web: '', p: 2,
    notes: '', contacts: [],
    projects: [
      {
        id: 'fjp', name: 'Driver app', desc: 'Route planning and proof of delivery for drivers.', state: 'maint', pct: 100,
        due: '2026-08-30', team: [2], sup: DRIVER_APP_SUPPORT,
        epics: [
          { id: 'f1', name: 'Route planning', state: 'done', pct: 100, sprints: 0 },
          { id: 'f2', name: 'Proof of delivery', state: 'done', pct: 100, sprints: 0 },
        ],
      },
    ],
    ourRoles: {}, archived: false, archivedAt: null,
  },
  {
    id: 'hav', name: 'Havbruk AS', industry: 'Aquaculture', country: 'Norway', web: '', p: 3,
    notes: 'New client, kickoff in November.',
    contacts: [{ personId: 10, name: 'Ola Nilsen', role: 'CEO', email: 'ola@havbruk.no', projects: [] }],
    projects: [], ourRoles: {}, archived: false, archivedAt: null,
  },
  ...DEVOPS_CLIENTS(),
]

/** A client of the DevOps board with one project per DevOps item (kept small: no contacts, no team yet). */
function client(id: string, name: string, industry: string, country: string, p: number, projects: ClientProject[]): Company {
  return { id, name, industry, country, web: '', p, notes: '', contacts: [], projects, ourRoles: {}, archived: false, archivedAt: null }
}

function proj(id: string, name: string, desc: string, state: ClientProject['state'], pct: number, due: string): ClientProject {
  return { id, name, desc, state, pct, due, team: [], epics: [] }
}

/**
 * The DevOps board's clients (v5: every DevOps item is a project). Each DevOps
 * sample item links to one of these projects; see DEVOPS_PROJECT_LINKS in api/devops/seed.ts.
 */
export function DEVOPS_CLIENTS(): Company[] {
  return [
    client('inoff', 'Inoff', 'Professional services', 'Sweden', 4, [proj('inoffp', 'Intranet', 'Intranet on Microsoft 365 for Inoff staff.', 'active', 10, '2026-11-30')]),
    client('weland', 'Weland', 'Manufacturing', 'Sweden', 5, [proj('welp', 'Order portal', 'Ordering and order tracking for Weland dealers.', 'active', 30, '2026-10-31')]),
    client('alnarp', 'Alnarp', 'Agriculture', 'Sweden', 6, [
      proj('alnp1', 'Customer portal', 'Self-service portal for Alnarp customers.', 'done', 100, '2026-09-15'),
      proj('alnp2', 'Lead automation', 'Lead capture and follow-up automation.', 'active', 45, '2026-12-15'),
    ]),
    client('arc', 'ARC', 'Retail', 'Norway', 7, [proj('arcp', 'Fast', 'Fast checkout platform, released in versions.', 'active', 80, '2026-10-30')]),
    client('fatech', 'Fa tech', 'Technology', 'Sweden', 8, [proj('fatp', 'Website', 'Company website and blog.', 'active', 60, '2026-11-15')]),
    client('osby', 'OSBY', 'Retail', 'Sweden', 9, [proj('osbyp', 'Webshop', 'Online shop for OSBY products.', 'active', 55, '2026-11-20')]),
    client('redare', 'Redare', 'Travel', 'Norway', 10, [proj('redp', 'Booking platform', 'Bookings and payments for Redare trips.', 'active', 15, '2026-12-15')]),
    client('sst', 'SST', 'Membership organisation', 'Sweden', 11, [proj('sstp', 'Member portal', 'Member sign-up and member pages.', 'planned', 0, '')]),
    client('tryggratt', 'Tryggrätt', 'Legal services', 'Sweden', 12, [proj('trygp', 'Case app', 'Case handling app for Tryggrätt lawyers.', 'done', 100, '2026-09-01')]),
  ]
}

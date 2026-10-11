import type { Company } from '../types'
import { DRIVER_APP_SUPPORT } from '../projects/seed'

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
]

import type { Person } from '../types'

/**
 * The people directory. Seeded from the prototype's user list (U0 in the Users
 * page) and its sign-in list (USERS in Login), plus Bharath Reddy Panyala, who
 * appears on Tickets and in the time entries. Colours match `lib/theme.ts`.
 */
export const PEOPLE_SEED: Person[] = [
  {
    id: '1', name: 'Rahul', email: 'rahul@viljetech.com', org: 'vt', role: 'super', projects: 'all',
    colour: '#4870E8', active: true, last: 'Now',
  },
  {
    id: '2', name: 'Vivek', email: 'vivek@viljetech.com', org: 'vt', role: 'admin', devType: 'Backend', projects: 'all',
    colour: '#3E908F', active: true, last: '1h ago',
  },
  {
    id: '3', name: 'Chary', email: 'chary@viljetech.com', org: 'vt', role: 'dev', devType: 'Mobile', projects: ['dacop', 'nordp'],
    colour: '#B98A2F', active: true, last: '2h ago',
  },
  {
    id: '4', name: 'Bhavana P', email: 'bhavana@viljetech.com', org: 'vt', role: 'pm', projects: ['dacop', 'nordp', 'i2'],
    colour: '#D2724A', active: true, last: 'Yesterday',
  },
  {
    id: '5', name: 'Sofia', email: 'sofia@freelance.dev', org: 'vt', role: 'dev', devType: 'Frontend', emp: 'freelancer', projects: ['dacop'],
    colour: '#3F9079', active: true, last: '3h ago',
  },
  {
    id: '6', name: 'Arjun', email: 'arjun@viljetech.com', org: 'vt', role: 'devops', devType: 'DevOps', projects: 'all',
    colour: '#3E6FA8', active: true, last: 'Now',
  },
  {
    id: '7', name: 'Ingrid Solberg', email: 'ingrid@daco.no', org: 'daco', role: 'cadmin', projects: 'all',
    colour: '#56657A', active: true, last: '2 days ago',
  },
  {
    id: '8', name: 'Lars Moen', email: 'lars@daco.no', org: 'daco', role: 'cuser', projects: ['dacop'],
    colour: '#56657A', active: true, last: '4 days ago',
  },
  {
    id: '9', name: 'Kari Berg', email: 'kari@nordlys.no', org: 'nord', role: 'cadmin', projects: 'all',
    colour: '#56657A', active: true, last: '1 week ago',
  },
  {
    id: '10', name: 'Ola Nilsen', email: 'ola@havbruk.no', org: 'hav', role: 'cuser', projects: [],
    colour: '#56657A', active: false, invited: true, last: 'Invited',
  },
  {
    id: '11', name: 'Bharath Reddy Panyala', email: 'bharath@viljetech.com', org: 'vt', role: 'dev', devType: 'Full-stack', projects: 'all',
    colour: '#9F89E5', active: true, last: 'Now',
  },
]

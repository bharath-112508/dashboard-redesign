import type { Person } from '../types';

/**
 * Accounts (prototype ACC, MEMC, FACE, CLIENTS). One sample account per role, in the
 * order the Sign in screen lists them. Lars Moen is a client commenter without an account.
 * Demo password for every sample account: DEMO_PASSWORD.
 */
export const DEMO_PASSWORD = 'demo';

export const PEOPLE_SEED: Person[] = [
  { name: 'Rahul', role: 'super', title: 'Super admin', email: 'rahul@viljetech.com', color: '#4870E8', face: 'm0', staffRole: 'Super admin', active: true },
  { name: 'Bhavana P', role: 'admin', title: 'Admin · Backend developer', email: 'bhavana@viljetech.com', color: '#9F89E5', face: 'w0', staffRole: 'Admin', active: true },
  { name: 'Vivek', role: 'pm', title: 'Project manager', email: 'vivek@viljetech.com', color: '#3E908F', face: 'm1', staffRole: 'Project manager', active: true },
  { name: 'Chary', role: 'dev', title: 'Developer · Frontend', email: 'chary@viljetech.com', color: '#B98A2F', face: 'm2', staffRole: 'Developer', active: true },
  { name: 'Arjun', role: 'free', title: 'Freelancer · Mobile', email: 'arjun@freelance.dev', color: '#D2724A', face: 'm4', staffRole: 'Freelancer', active: true },
  { name: 'Ganesh', role: 'devops', title: 'DevOps engineer', email: 'ganesh@viljetech.com', color: '#3F9079', face: 'm6', staffRole: 'DevOps engineer', active: true },
  { name: 'Ingrid Solberg', role: 'client', title: 'Daco · Client admin', email: 'ingrid@daco.no', color: '#1B2D45', client: true, active: true },
  { name: 'Lars Moen', role: null, title: 'Daco · Client user', email: 'lars@daco.no', color: '#56657A', client: true, active: true },
];

/** Default avatar colour for anyone not in the people list. */
export const DEFAULT_PERSON_COLOR = '#56657A';

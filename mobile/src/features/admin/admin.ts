/** Pure filters for Users and Companies (W3). */
import type { Company, Person, Role } from '@/data/types';

export type OrgFilter = 'vt' | 'client' | 'all';

/** Users list (V-70): search name + email, Viljetech / Clients / All, role chip. */
export function filterUsers(people: Person[], q: string, org: OrgFilter, role: Role | 'all'): Person[] {
  const t = q.trim().toLowerCase();
  return people.filter(
    (u) =>
      (org === 'all' || (org === 'vt' ? u.org === 'vt' : u.org !== 'vt')) &&
      (role === 'all' || u.role === role) &&
      (!t || `${u.name} ${u.email}`.toLowerCase().includes(t)),
  );
}

/** "email · devType · Freelancer" */
export function userSub(u: Person): string {
  return u.email + (u.devType ? ` · ${u.devType}` : '') + (u.emp === 'freelancer' ? ' · Freelancer' : '');
}

/** Companies list: Active / Archived and a name search. */
export function filterCompanies(companies: Company[], q: string, archived: boolean): Company[] {
  const t = q.trim().toLowerCase();
  return companies.filter((c) => c.archived === archived && (!t || c.name.toLowerCase().includes(t)));
}

/** The user sheet's project access: 'all' when "All projects" is picked. */
export function accessFrom(values: string[]): 'all' | string[] {
  return values.includes('all') ? 'all' : values;
}

import { STAFF_ROLES } from '@/data/constants';
import { plural } from '@/data/format';
import { projectsOfCompany, staffPeople } from '@/data/selectors';
import type { AppState } from '@/data/store/state';
import type { Person, Project, StaffRole } from '@/data/types';

export interface CompanyRowVM {
  name: string;
  /** "3 projects · 2 contacts" */
  meta: string;
}

/** S-COMPANIES: active or archived companies. */
export function companyRows(s: AppState, archived: boolean): CompanyRowVM[] {
  return s.companies
    .filter((c) => c.archived === archived)
    .map((c) => ({
      name: c.name,
      meta: `${plural(projectsOfCompany(s, c.name).length, 'project')} · ${plural(c.contacts.length, 'contact')}`,
    }));
}

/**
 * Status label on the Company detail project rows. Maintenance projects read
 * "Maintenance" (DECISIONS.md 5; the prototype showed "Active").
 */
export function companyProjectStatus(p: Project): string {
  switch (p.status) {
    case 'done':
      return 'Done';
    case 'planned':
      return 'Planned';
    case 'maint':
      return 'Maintenance';
    default:
      return 'Active';
  }
}

/** The Users & roles label of a person (falls back to the first part of the title). */
export function staffRoleOf(p: Person): StaffRole {
  return p.staffRole ?? (p.title.split(' · ')[0] as StaffRole);
}

/** S-USERS: role count chips, in STAFF_ROLES order. */
export function roleCounts(s: AppState): { role: StaffRole; n: number }[] {
  const people = staffPeople(s);
  return STAFF_ROLES.map((role) => ({ role, n: people.filter((p) => staffRoleOf(p) === role).length }));
}

import { PAGE_ACCESS, PDEF } from '../constants';
import type { AppState } from '../store/state';
import type { Page, PermKey, PermMatrix, Role } from '../types';
import { me } from './session';

/**
 * Page access (`can(page)`, SPEC §2.2): identical to the web `session/access.ts`.
 * "My Tickets" uses the Tickets rule.
 */
export function can(role: Role | null | undefined, page: Page | 'My Tickets'): boolean {
  if (!role) return false;
  const p: Page = page === 'My Tickets' ? 'Tickets' : page;
  const a = PAGE_ACCESS[role];
  return a === '*' || a.includes(p);
}

/**
 * Action permission (`perm(key)`, SPEC §2.3) from the editable matrix. Super always has
 * every permission; client roles have none.
 */
export function perm(role: Role | null | undefined, key: PermKey, matrix: PermMatrix = PDEF): boolean {
  if (!role) return false;
  if (role === 'super') return true;
  return !!matrix[role]?.[key];
}

/** `can(page)` for the signed-in person. */
export const myCan = (s: AppState, page: Page | 'My Tickets'): boolean => can(me(s)?.role, page);

/** `perm(key)` for the signed-in person, against the persisted matrix. */
export const myPerm = (s: AppState, key: PermKey): boolean => perm(me(s)?.role, key, s.perms);

/** Project status badge and support-terms pencils (`canSet`): super, admin, pm. */
export const canSetProjectStatus = (role: Role | null | undefined): boolean => role === 'super' || role === 'admin' || role === 'pm';

/** DevOps settings editing: super, admin, devops. */
export const canEditDevopsSettings = (role: Role | null | undefined): boolean => role === 'super' || role === 'admin' || role === 'devops';

/** `canDv()`: every DevOps edit (perm devops.edit, or the devops role regardless). */
export const canDv = (s: AppState): boolean => myPerm(s, 'devops.edit') || me(s)?.role === 'devops';

/** Toggling the permission matrix: super and admin only. */
export const canEditPermissions = (role: Role | null | undefined): boolean => role === 'super' || role === 'admin';

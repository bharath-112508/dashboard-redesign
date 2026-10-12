import { FACE_OF, NAME_COLOURS, DEFAULT_AVATAR, ROLE_LABEL } from '../constants';
import { SAMPLE_ACCOUNT_IDS } from '../seed/people';
import type { AppState } from '../store/state';
import type { ClientRole, FaceKey, Person, Role } from '../types';

/** The signed-in person, or null. */
export function me(s: AppState): Person | null {
  const id = s.session.personId;
  return id == null ? null : (s.people.find((p) => p.id === id) ?? null);
}

export const myRole = (s: AppState): Role | null => me(s)?.role ?? null;
export const myName = (s: AppState): string => me(s)?.name ?? '';

export function personById(s: AppState, id: number): Person | undefined {
  return s.people.find((p) => p.id === id);
}

export function personByName(s: AppState, name: string): Person | undefined {
  return s.people.find((p) => p.name === name);
}

/** Case-insensitive, trimmed. */
export function personByEmail(s: AppState, email: string): Person | undefined {
  const e = email.trim().toLowerCase();
  return s.people.find((p) => p.email.toLowerCase() === e);
}

export function isClientRole(role: Role | null | undefined): role is ClientRole {
  return role === 'cadmin' || role === 'cuser';
}

/** `isCl()` for the signed-in person. */
export const isClient = (s: AppState): boolean => isClientRole(myRole(s));

/** `free()`: a freelancer has no 8h/day requirement, no idle time, no 40h target. */
export const isFreelancer = (p: Person | null | undefined): boolean => p?.emp === 'freelancer';

/** Staff photos are shown to staff viewers only (SPEC §2.4). */
export const seesPhotos = (role: Role | null | undefined): boolean => !!role && !isClientRole(role);

/** "Developer · Freelancer", "Client admin". */
export function roleLabel(p: Pick<Person, 'role' | 'emp'>): string {
  return ROLE_LABEL[p.role] + (p.emp === 'freelancer' ? ' · Freelancer' : '');
}

/** "Viljetech" or the client company's name. */
export function orgName(s: AppState, p: Pick<Person, 'org'>): string {
  if (p.org === 'vt') return 'Viljetech';
  return s.companies.find((c) => c.id === p.org)?.name ?? p.org;
}

/** Sample accounts on Sign in, in order. */
export function sampleAccounts(s: AppState): Person[] {
  return SAMPLE_ACCOUNT_IDS.map((id) => s.people.find((p) => p.id === id)).filter((p): p is Person => !!p);
}

/** Active Viljetech staff (team pickers). */
export function activeStaff(s: AppState): Person[] {
  return s.people.filter((p) => p.org === 'vt' && p.active);
}

export interface AvatarInfo {
  name: string;
  initials: string;
  colour: string;
  /** a built-in face, or an uploaded data URL; undefined = initials */
  face?: FaceKey;
  photo?: string;
}

/**
 * Avatar for a name as seen by `viewer` (SPEC §2.4): staff viewers see staff photos
 * (uploaded, or the built-in face); clients, and client people, show initials.
 */
export function avatarOf(s: AppState, name: string, viewer: Role | null | undefined): AvatarInfo {
  const p = personByName(s, name);
  const initials = name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const colour = p?.colour ?? NAME_COLOURS[name] ?? DEFAULT_AVATAR;
  const info: AvatarInfo = { name, initials, colour };
  if (!seesPhotos(viewer)) return info;
  if (p && p.org !== 'vt') return info;
  if (p?.photo) return { ...info, photo: p.photo };
  if (p?.photo === '') return info;
  const face = FACE_OF[name] ?? FACE_OF[name.split(' ')[0]];
  return face ? { ...info, face } : info;
}

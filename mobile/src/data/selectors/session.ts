import { STAFF_ALL } from '../constants';
import { DEFAULT_PERSON_COLOR } from '../seed/people';
import type { AppState } from '../store/state';
import type { FaceKey, Person, Role } from '../types';

/** The signed-in person, or null when signed out. */
export function me(s: AppState): Person | null {
  const name = s.session.user;
  return name ? (s.people.find((p) => p.name === name) ?? null) : null;
}

/** The signed-in role, or null. */
export function myRole(s: AppState): Role | null {
  return me(s)?.role ?? null;
}

export function personByName(s: AppState, name: string): Person | undefined {
  return s.people.find((p) => p.name === name);
}

/** Case-insensitive email match. */
export function findPersonByEmail(s: AppState, email: string): Person | undefined {
  const e = email.trim().toLowerCase();
  return s.people.find((p) => p.email.toLowerCase() === e);
}

/** Sample accounts on the Sign in screen, one per role, in seed order. */
export function sampleAccounts(s: AppState): Person[] {
  return s.people.filter((p) => p.role !== null);
}

/** Staff people (no clients), for Users & roles and Team hours. */
export function staffPeople(s: AppState): Person[] {
  return s.people.filter((p) => !p.client && p.role !== null);
}

export interface Capabilities {
  role: Role;
  /** pm, admin, super */
  staffAll: boolean;
  /** dev, free, devops */
  isIC: boolean;
  isClient: boolean;
  isFree: boolean;
  isDevops: boolean;
  /** approves leave (staffAll) */
  canApprove: boolean;
  canSetProjectStatus: boolean;
  /** has Leave & comp-off (not client, not free) */
  hasLeave: boolean;
  /** shows idle time and the 40h target (not free) */
  showIdle: boolean;
  /** maintenance Support mode */
  maintMode: 'client' | 'staff' | 'ic';
  /** sees staff photos (clients see initials only) */
  seesPhotos: boolean;
  /** sees the Critical badge (clients see Critical as High) */
  seesCritical: boolean;
}

/** What a role can see and do (SPEC.md §2.1). */
export function capabilities(role: Role): Capabilities {
  const staffAll = STAFF_ALL.includes(role);
  const isClient = role === 'client';
  const isFree = role === 'free';
  return {
    role,
    staffAll,
    isIC: role === 'dev' || role === 'free' || role === 'devops',
    isClient,
    isFree,
    isDevops: role === 'devops',
    canApprove: staffAll,
    canSetProjectStatus: staffAll,
    hasLeave: !isClient && !isFree,
    showIdle: !isFree,
    maintMode: isClient ? 'client' : staffAll ? 'staff' : 'ic',
    seesPhotos: !isClient,
    seesCritical: !isClient,
  };
}

export interface AvatarInfo {
  name: string;
  initials: string;
  color: string;
  /** null when the viewer is a client or the person is a client */
  face: FaceKey | null;
}

/** Avatar data for a person name as the signed-in viewer sees it. */
export function avatarOf(s: AppState, name: string): AvatarInfo {
  const p = personByName(s, name);
  const viewer = myRole(s);
  const initials = (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const face = viewer !== 'client' && p && !p.client && p.face ? p.face : null;
  return { name, initials, color: p?.color ?? DEFAULT_PERSON_COLOR, face };
}

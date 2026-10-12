import { router, type Href } from 'expo-router';

import type { NotificationTarget, Role } from '@/data/types';
import { isTabOf, type TabKey } from './tabs';

/**
 * Typed route helpers. Features navigate only through these (or plain hrefs built here),
 * so route files can move without touching feature code.
 *
 * Navigation model (SPEC §1.2): one stack per session. A tab is the root of the stack;
 * pushed screens sit on top and the tab that started the stack stays highlighted.
 */

const enc = encodeURIComponent;

export const href = {
  tab: (key: TabKey) => `/${key}` as Href,
  ticket: (id: number) => `/ticket/${id}` as Href,
  question: (id: number) => `/question/${id}` as Href,
  project: (name: string) => `/project/${enc(name)}` as Href,
  company: (name: string) => `/company/${enc(name)}` as Href,
  user: (name: string) => `/user/${enc(name)}` as Href,
  inbox: () => '/inbox' as Href,
  me: () => '/me' as Href,
  leave: () => '/leave' as Href,
  team: () => '/team' as Href,
  companies: () => '/companies' as Href,
  users: () => '/users' as Href,
  dvset: () => '/dvset' as Href,
  history: () => '/history' as Href,
  board: () => '/board' as Href,
  /** pushed copies of tab screens, for roles where they are not a tab */
  stack: (key: 'projects' | 'devops' | 'tickets') => `/stack/${key}` as Href,
  signIn: () => '/sign-in' as Href,
};

// ── Sheets ──────────────────────────────────────────────────────────────────

/** Sheet params contract (BUILD-PLAN rule 3). All values travel as strings in the URL. */
export interface SheetParams {
  /** Log time: preset ticket, day, project, or text (support logging M-34) */
  'log-time': { ticketId?: number; day?: string; project?: string; text?: string };
  /** Report a problem / Request a change */
  report: { project?: string; kind?: 'Bug' | 'Change' };
  /** New leave request */
  leave: Record<string, never>;
  /** Project status (staffAll) */
  'project-status': { project: string };
  /** Set up maintenance / Edit support plan */
  'support-plan': { project: string };
}

export type SheetName = keyof SheetParams;

export function sheetHref<N extends SheetName>(name: N, params?: SheetParams[N]): Href {
  const q = Object.entries(params ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`)
    .join('&');
  return `/sheet/${name}${q ? `?${q}` : ''}` as Href;
}

/** Open a bottom sheet route over the current screen. */
export function openSheet<N extends SheetName>(name: N, params?: SheetParams[N]): void {
  router.push(sheetHref(name, params));
}

/** Close the current sheet (or any modal route). */
export function closeSheet(): void {
  if (router.canGoBack()) router.back();
}

// ── Stack operations ──────────────────────────────────────────────────────

/** Push a screen onto the current tab's stack. */
export function push(to: Href): void {
  router.push(to);
}

/** Pop one screen (M-45). */
export function back(): void {
  if (router.canGoBack()) router.back();
}

/**
 * Switch tab (M-05): resets the stack to that tab's root, like the prototype's tab(s).
 */
export function goTab(key: TabKey): void {
  if (router.canDismiss()) router.dismissTo(href.tab(key));
  else router.navigate(href.tab(key));
}

/**
 * Open the screen for a More tile / feature key: a tab if the role has it as a tab,
 * otherwise the pushed copy (e.g. DevOps board for pm, Projects for devops).
 */
export function hrefForKey(key: MoreKey, role: Role): Href {
  if (isTabOf(role, key)) return href.tab(key as TabKey);
  switch (key) {
    case 'projects':
    case 'devops':
    case 'tickets':
      return href.stack(key);
    case 'time':
    case 'questions':
    case 'bugs':
      return href.tab(key);
    default:
      return `/${key}` as Href;
  }
}

/** Keys of More tiles and Home links (prototype screen keys). */
export type MoreKey =
  | 'tickets'
  | 'board'
  | 'time'
  | 'history'
  | 'team'
  | 'projects'
  | 'companies'
  | 'users'
  | 'devops'
  | 'dvset'
  | 'questions'
  | 'bugs'
  | 'inbox'
  | 'leave';

/** Where a notification leads (M-06). The DevOps target also expands that project. */
export function notificationHref(target: NotificationTarget): Href {
  switch (target.kind) {
    case 'ticket':
      return href.ticket(target.id);
    case 'question':
      return href.question(target.id);
    case 'project':
      return href.project(target.name);
    case 'leave':
      return href.leave();
    case 'devops':
      // The prototype pushes the board for every role, devops included.
      return href.stack('devops');
  }
}

/** Ticket detail, a shortcut used everywhere (M-11). */
export function toTicket(id: number): void {
  push(href.ticket(id));
}

export function toProject(name: string): void {
  push(href.project(name));
}

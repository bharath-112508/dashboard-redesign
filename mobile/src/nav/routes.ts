import { router, type Href } from 'expo-router';

import type { Role } from '@/data/types';

import { isTabOf, type TabKey } from './tabs';

/**
 * Typed route helpers (DELTA §1). Features navigate only through these, so route files
 * can move without touching feature code.
 *
 * Navigation model (SPEC §1.2): one stack per session. A tab is the root of the stack;
 * pushed screens sit on top and the tab that started the stack stays highlighted.
 */

const enc = encodeURIComponent;
const q = (params: Record<string, string | number | null | undefined>) => {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`)
    .join('&');
  return s ? `?${s}` : '';
};

/** Project detail tabs (`?tab=`). */
export type ProjectTab = 'overview' | 'support' | 'board' | 'list' | 'sprints' | 'timeline' | 'files' | 'time' | 'team' | 'devops' | 'questions' | 'bugs';
/** DevOps project tabs (`?tab=`). */
export type DevopsTab = 'status' | 'details' | 'deploys' | 'requests' | 'notes';

export const href = {
  tab: (key: TabKey) => `/${key}` as Href,
  /** ticket detail by key (V-20) */
  ticket: (key: string) => `/ticket/${enc(key)}` as Href,
  /** subtask by stable id "PMT-11.s2" (A-11) */
  subtask: (id: string) => `/subtask/${enc(id)}` as Href,
  project: (id: string, tab?: ProjectTab, extra?: Record<string, string>) => `/project/${enc(id)}${q({ tab, ...extra })}` as Href,
  company: (id: string) => `/company/${enc(id)}` as Href,
  /** company timesheets, optionally filtered to one project */
  companyTime: (co: string, pf?: string) => `/company-time/${enc(co)}${q({ pf })}` as Href,
  user: (id: number) => `/user/${id}` as Href,
  question: (id: number) => `/question/${id}` as Href,
  bug: (id: string) => `/bug/${enc(id)}` as Href,
  dvp: (key: string, tab?: DevopsTab) => `/dvp/${enc(key)}${q({ tab })}` as Href,
  request: (id: number) => `/request/${id}` as Href,
  portal: (co: string) => `/portal/${enc(co)}` as Href,
  search: () => '/search' as Href,
  emp: () => '/emp' as Href,
  clients: () => '/clients' as Href,
  companies: () => '/companies' as Href,
  users: () => '/users' as Href,
  dvset: () => '/dvset' as Href,
  me: () => '/me' as Href,
  /** "My leave" (A-2) */
  leave: () => '/leave' as Href,
  /** DevOps board pushed for super/admin */
  devopsStack: () => '/stack/devops' as Href,
  signIn: () => '/sign-in' as Href,
};

// ── Sheets ──────────────────────────────────────────────────────────────────

/**
 * URL sheet params contract (BUILD-PLAN rule 3). Values travel as strings in the URL;
 * read them with `useLocalSearchParams<SheetQuery<'log-time'>>()`.
 */
export interface SheetParams {
  /** SH-LOG: preset day, project value (c:/i:/x:admin), ticket/subtask key, text; or edit an entry id */
  'log-time': { date?: string; proj?: string; key?: string; text?: string; id?: number };
  /** SH-NEWTICKET */
  'new-ticket': { pid: string };
  /** SH-NEWPROJECT (preset company hides the client/internal segment) */
  'new-project': { co?: string };
  /** SH-PROJSTATUS */
  'project-status': { id: string };
  /** SH-SUPTERMS */
  'support-terms': { id: string };
  /** SH-SUPREQ */
  'support-request': { pid: string; kind: 'problem' | 'change' };
  /** SH-NEWREQ (DevOps key) */
  'devops-request': { key: string };
  /** SH-NEWQ (title prefilled for "Ask a follow-up") */
  'new-question': { pid: string; title?: string };
  /** SH-NEWBUG */
  'report-bug': { pid?: string };
  /** SH-LEAVE (preset person, approvers) */
  leave: { who?: string };
  /** SH-USER (edit when id) */
  user: { id?: number };
  /** SH-COMPANY (edit when id) */
  company: { id?: string };
  /** SH-CONTACT (edit when i = contact index) */
  contact: { co: string; i?: number };
  /** SH-CMEMBER (edit when email) */
  'client-member': { email?: string };
}

export type SheetName = keyof SheetParams;

/** The params as `useLocalSearchParams` returns them (strings). */
export type SheetQuery<N extends SheetName> = { [K in keyof SheetParams[N]]?: string };

export const SHEETS: readonly SheetName[] = [
  'log-time',
  'new-ticket',
  'new-project',
  'project-status',
  'support-terms',
  'support-request',
  'devops-request',
  'new-question',
  'report-bug',
  'leave',
  'user',
  'company',
  'contact',
  'client-member',
];

export function sheetHref<N extends SheetName>(name: N, params?: SheetParams[N]): Href {
  return `/sheet/${name}${q((params ?? {}) as Record<string, string | number | undefined>)}` as Href;
}

/** Open a URL bottom sheet over the current screen. */
export function openSheet<N extends SheetName>(name: N, params?: SheetParams[N]): void {
  router.push(sheetHref(name, params));
}

/** Close the current sheet route. */
export function closeSheet(): void {
  if (router.canGoBack()) router.back();
}

// ── Stack operations ──────────────────────────────────────────────────────

/** Push a screen onto the current tab's stack. */
export function push(to: Href): void {
  router.push(to);
}

/** Pop one screen. */
export function back(): void {
  if (router.canGoBack()) router.back();
}

/** Switch tab (V-05): resets the stack to that tab's root. */
export function goTab(key: TabKey): void {
  if (router.canDismiss()) router.dismissTo(href.tab(key));
  else router.navigate(href.tab(key));
}

/** v5 page keys used by dashboard links, KPI tiles, More and search (`tab2`). */
export type PageKey =
  | 'dash'
  | 'projects'
  | 'mytickets'
  | 'time'
  | 'devops'
  | 'portal'
  | 'questions'
  | 'bugs'
  | 'more'
  | 'emp'
  | 'users'
  | 'clients'
  | 'companies'
  | 'search'
  | 'dvset'
  | 'profile'
  | 'leave';

const TAB_OF: Partial<Record<PageKey, TabKey>> = {
  dash: 'home',
  projects: 'projects',
  portal: 'projects',
  mytickets: 'tickets',
  time: 'time',
  devops: 'devops',
  questions: 'questions',
  bugs: 'bugs',
  more: 'more',
};

const PUSHED: Partial<Record<PageKey, () => Href>> = {
  emp: href.emp,
  users: href.users,
  clients: href.clients,
  companies: href.companies,
  search: href.search,
  dvset: href.dvset,
  profile: href.me,
  leave: href.leave,
  devops: href.devopsStack,
};

/** Where a page key leads for a role: its tab, or the pushed screen. */
export function pageHref(page: PageKey, role: Role | null | undefined): Href {
  const tab = TAB_OF[page];
  if (tab && isTabOf(role, tab)) return href.tab(tab);
  const p = PUSHED[page];
  if (p) return p();
  return href.tab(tab ?? 'home');
}

/**
 * `tab2(p)` (SPEC §1.2): switch tab when the page is one of the role's tabs, push it
 * otherwise. Used by dashboard links, More and search results.
 */
export function tab2(page: PageKey, role: Role | null | undefined): void {
  const tab = TAB_OF[page];
  if (tab && isTabOf(role, tab)) goTab(tab);
  else push(pageHref(page, role));
}

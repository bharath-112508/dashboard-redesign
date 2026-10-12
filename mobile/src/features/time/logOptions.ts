/** Pure option builders for SH-LOG (project picker, ticket and subtask picker). */
import { projAll, subOf, ticketsOf } from '@/data/selectors';
import type { AppState } from '@/data/store';

export interface LogProjectOption {
  /** 'c:<id>' | 'i:<id>' | 'x:admin' */
  value: string;
  title: string;
  /** company name, "Viljetech" or "Non-billable" */
  sub: string;
  kind: 'client' | 'internal' | 'admin';
  /** project id (client / internal) */
  id?: string;
}

export const ADMIN_VALUE = 'x:admin';

/**
 * The inline project picker: client projects (not completed, active companies) and
 * internal projects plus "Admin & meetings". The current value stays listed even when
 * its project is completed.
 */
export function logProjectOptions(s: AppState, current = ''): { client: LogProjectOption[]; internal: LogProjectOption[] } {
  const all = projAll(s);
  const keep = (v: string, state: string) => state !== 'done' || v === current;
  const client = all
    .filter((p) => p.kind === 'client' && keep(`c:${p.id}`, p.state))
    .map((p): LogProjectOption => ({ value: `c:${p.id}`, title: p.name, sub: p.co, kind: 'client', id: p.id }));
  const internal = all
    .filter((p) => p.kind === 'internal' && keep(`i:${p.id}`, p.state))
    .map((p): LogProjectOption => ({ value: `i:${p.id}`, title: p.name, sub: 'Viljetech', kind: 'internal', id: p.id }));
  internal.push({ value: ADMIN_VALUE, title: 'Admin & meetings', sub: 'Non-billable', kind: 'admin' });
  return { client, internal };
}

/** The option for a value, also for completed projects or archived companies. */
export function logProjectOption(s: AppState, value: string): LogProjectOption | null {
  if (!value) return null;
  if (value === ADMIN_VALUE) return { value, title: 'Admin & meetings', sub: 'Non-billable', kind: 'admin' };
  const id = value.slice(2);
  const p = s.projects.find((x) => x.id === id);
  if (!p) return null;
  const co = p.kind === 'client' ? (s.companies.find((c) => c.id === p.companyId)?.name ?? '') : 'Viljetech';
  return { value, title: p.name, sub: co, kind: p.kind, id };
}

export interface LogTicketOption {
  /** ticket key, or the stable subtask id (A-11) */
  value: string;
  /** displayed key: "PMT-11" or "PMT-11.2" */
  k: string;
  title: string;
  sub: string;
}

/**
 * Open tickets of a project with their subtasks (`↳ title`, key "PMT-11.2", value the
 * subtask id). A done ticket stays listed when it is the current value.
 */
export function logTicketOptions(s: AppState, projectValue: string, current = ''): LogTicketOption[] {
  if (!projectValue || projectValue === ADMIN_VALUE) return [];
  const pid = projectValue.slice(2);
  const cur = normalizeKey(s, current);
  const epicName = (id: string) => s.epics.find((e) => e.id === id)?.name ?? '';
  return ticketsOf(s, pid)
    .filter((t) => t.st !== 'done' || t.key === cur || t.subs.some((x) => x.id === cur))
    .flatMap((t) => [
      { value: t.key, k: t.key, title: t.title, sub: epicName(t.epicId) },
      ...t.subs.map((x, i) => ({ value: x.id, k: `${t.key}.${i + 1}`, title: `↳ ${x.title}`, sub: `Subtask of ${t.key}` })),
    ]);
}

/** A positional subtask key ("PMT-11.2") becomes its stable id; ticket keys stay. */
export function normalizeKey(s: AppState, key: string | undefined): string {
  if (!key) return '';
  if (/\.\d+$/.test(key)) return subOf(s, key)?.id ?? key;
  return key;
}

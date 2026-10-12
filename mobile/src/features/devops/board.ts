/**
 * Pure helpers of the DevOps board (S5-DEVOPS) and project (S5-DVP): filters, grouping,
 * ladder state. No React, no store: unit-tested in __tests__/board.test.ts.
 */
import { DEVOPS_PHASES, DEVSTEPS, devopsTone, phaseOf } from '@/data/constants';
import { isDevopsOverdue, type DevopsView } from '@/data/selectors';
import type { DevopsProject, DevopsSettings } from '@/data/types';
import type { ToneName } from '@/theme';

export type BoardFilter = 'all' | 'late' | 'client' | 'cicd' | 'mine';
export type BoardGroup = 'phase' | 'owner' | 'dev';

/** Overdue follow-up (stored flag or a reminder before TODAY). */
export const overdue = (d: Pick<DevopsProject, 'overdue' | 'reminder'>): boolean => isDevopsOverdue(d);

/** Does a record pass the chip filter? `me` is the signed-in name (Mine = owner). */
export function passes(d: DevopsView, f: BoardFilter, me: string): boolean {
  switch (f) {
    case 'late':
      return overdue(d);
    case 'client':
      return d.from === 'Client';
    case 'cicd':
      return d.cicd;
    case 'mine':
      return d.owner === me;
    default:
      return true;
  }
}

/** Search matches the project name, the DevOps key and the company (SPEC 2.6). */
export function matches(d: DevopsView, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return `${d.name} ${d.key} ${d.company}`.toLowerCase().includes(s);
}

export function filterBoard(list: DevopsView[], f: BoardFilter, q: string, me: string): DevopsView[] {
  return list.filter((d) => passes(d, f, me) && matches(d, q));
}

/** Counts for the chips (over the whole board, as v5). */
export function chipCounts(list: DevopsView[], me: string): Record<BoardFilter, number> {
  return {
    all: list.length,
    late: list.filter(overdue).length,
    client: list.filter((d) => d.from === 'Client').length,
    cicd: list.filter((d) => d.cicd).length,
    mine: list.filter((d) => d.owner === me).length,
  };
}

export interface BoardGroupView {
  name: string;
  tone: ToneName;
  items: DevopsView[];
}

/** Dev phase groups (Dev phase segment). */
export const DEV_GROUPS = [...DEVSTEPS, 'Not set'] as const;

/** Groups for the segment; empty groups are dropped. */
export function groupBoard(list: DevopsView[], g: BoardGroup): BoardGroupView[] {
  let groups: BoardGroupView[];
  if (g === 'phase') {
    groups = DEVOPS_PHASES.map(({ phase, tone }) => ({ name: phase, tone, items: list.filter((d) => phaseOf(d.infra) === phase) }));
  } else if (g === 'owner') {
    const names = [...new Set(list.map((d) => d.owner || 'Unassigned'))];
    groups = names.map((n) => ({ name: n, tone: 'grey' as ToneName, items: list.filter((d) => (d.owner || 'Unassigned') === n) }));
  } else {
    groups = DEV_GROUPS.map((n) => ({
      name: n,
      tone: 'blue' as ToneName,
      items: list.filter((d) => (n === 'Not set' ? !(DEVSTEPS as readonly string[]).includes(d.dev) : d.dev === n)),
    }));
  }
  return groups.filter((x) => x.items.length);
}

export { devopsTone, phaseOf };

/** Phase tone of a status (settings badges). */
export function phaseTone(status: string): ToneName {
  const p = phaseOf(status);
  return DEVOPS_PHASES.find((x) => x.phase === p)?.tone ?? 'grey';
}

/** Client ladder state: `client` when Action from is Client and the action is a ladder step. */
export function ladderState(d: Pick<DevopsProject, 'from' | 'act' | 'step'>, S: Pick<DevopsSettings, 'ladder'>): { client: boolean; ix: number } {
  const names = S.ladder.map((x) => x.n);
  const client = d.from === 'Client' && names.includes(d.act);
  return { client, ix: client ? (d.step ?? names.indexOf(d.act)) : -1 };
}

/** Next ladder step name ('' at the end or for internal records). */
export function nextLadderStep(d: Pick<DevopsProject, 'from' | 'act' | 'step'>, S: Pick<DevopsSettings, 'ladder'>): string {
  const { client, ix } = ladderState(d, S);
  if (!client || ix >= S.ladder.length - 1) return '';
  return S.ladder[ix + 1].n;
}

/** Default "Next step name" for the internal ladder. */
export function nextInternalName(d: Pick<DevopsProject, 'ifu'>, S: Pick<DevopsSettings, 'iladder'>): string {
  return S.iladder[Math.min((d.ifu ?? []).length, S.iladder.length - 1)] ?? '';
}

/** Request priority tone (`reqRow`). */
export function requestTone(r: { status: string; prio: string }): ToneName {
  if (r.status === 'Done') return 'green';
  if (r.prio === 'High' || r.prio === 'Critical') return 'red';
  if (r.prio === 'Medium') return 'amber';
  return 'grey';
}

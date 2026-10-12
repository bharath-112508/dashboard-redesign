/** Timeline view model (S-PROJECT Timeline): one bar per sprint on a shared date range. */
import { TODAY } from '@/data/clock';
import { diff, sh } from '@/data/format';
import type { AppState } from '@/data/store';
import type { SprintState } from '@/data/types';

import { projectSprints } from './selectors';

export interface TimelineRow {
  label: string;
  dates: string;
  /** 0–100 */
  left: number;
  width: number;
  state: SprintState;
}

export interface TimelineVM {
  empty: boolean;
  range: string;
  /** today's position, 0–100 */
  today: number;
  rows: TimelineRow[];
}

export function timeline(s: AppState, project: string): TimelineVM {
  const sps = projectSprints(s, project);
  if (!sps.length) return { empty: true, range: '', today: 0, rows: [] };
  const a0 = sps.reduce((m, x) => (x.a < m ? x.a : m), sps[0].a);
  const b0 = sps.reduce((m, x) => (x.b > m ? x.b : m), sps[0].b);
  const span = Math.max(1, diff(b0, a0) + 1);
  const pc = (d: string) => Math.max(0, Math.min(1, diff(d, a0) / span)) * 100;
  return {
    empty: false,
    range: `${sh(a0)} – ${sh(b0)}`,
    today: pc(TODAY),
    rows: sps.map((x) => ({
      label: `${x.e} · ${x.n}`,
      dates: `${sh(x.a)} – ${sh(x.b)}`,
      left: pc(x.a),
      width: ((diff(x.b, x.a) + 1) / span) * 100,
      state: x.st,
    })),
  };
}

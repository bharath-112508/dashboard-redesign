import { useMemo, useState } from 'react';

import { Block, FilterChips, ProjectTile, Row, Rows, Screen, SearchField, Segmented, EmptyBlock, type HeaderAction, type RowMeta } from '@/components';
import { PRIORITY_DOT } from '@/data/constants';
import { dvShort, fmt, plural } from '@/data/format';
import { canDv, devopsAll, myName, type DevopsView } from '@/data/selectors';
import { useAppState } from '@/data/store';
import type { TicketPrio } from '@/data/types';
import { href, push } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';
import { colors } from '@/theme';

import { chipCounts, devopsTone, filterBoard, groupBoard, overdue, type BoardFilter, type BoardGroup } from './board';
import { DvNewSheet } from './DevopsSheets';

/** One board row: project tile and name (DECISIONS 3), next step, status, priority dot, meta. */
export function DevopsRow({ d }: { d: DevopsView }) {
  const late = overdue(d);
  const due = d.latestDue || d.initDue || '';
  const meta: (RowMeta | null)[] = [
    d.reminder ? { icon: 'bell', text: dvShort(d.reminder), color: late ? colors.danger : undefined, bold: late } : null,
    due ? { icon: 'flag', text: fmt(due) } : null,
    { icon: 'user-round', text: d.owner || 'Unassigned' },
    d.cicd ? { icon: 'git-branch', text: 'CI/CD', color: colors.greenInk } : null,
    d.openRequests ? { icon: 'git-pull-request', text: String(d.openRequests), color: colors.devopsInk, bold: true } : null,
  ];
  return (
    <Row
      lead={<ProjectTile id={d.projectId} />}
      title={d.name}
      label={`${d.name}, ${d.infra}`}
      sub={d.next || d.phase || 'No next step yet'}
      dot={d.prio && d.prio !== 'Not set' ? PRIORITY_DOT[d.prio as TicketPrio] : undefined}
      badge={{ label: d.infra, tone: devopsTone(d.infra) }}
      meta={meta}
      onPress={() => push(href.dvp(d.key))}
      testID={`dv-row-${d.key}`}
    />
  );
}

/**
 * S5-DEVOPS DevOps board: the `devops` tab (devops role) and `stack/devops` (super,
 * admin). Search, filter chips, group segment, project rows (V-90). "+" adds a project
 * (V-91, canDv).
 */
export function DevopsBoardScreen() {
  const all = useAppState(devopsAll);
  const me = useAppState(myName);
  const editable = useAppState(canDv);
  const root = useRootActions();
  const [q, setQ] = useState('');
  const [f, setF] = useState<BoardFilter>('all');
  const [g, setG] = useState<BoardGroup>('phase');
  const [adding, setAdding] = useState(false);

  const counts = useMemo(() => chipCounts(all, me), [all, me]);
  const groups = useMemo(() => groupBoard(filterBoard(all, f, q, me), g), [all, f, q, me, g]);

  const actions: HeaderAction[] = [
    ...(editable ? [{ icon: 'plus' as const, label: 'New project', onPress: () => setAdding(true), testID: 'dv-new' }] : []),
    { icon: 'settings', label: 'Settings', onPress: () => push(href.dvset()), testID: 'dv-settings' },
    ...root,
  ];

  const chips = [
    { value: 'all' as const, label: 'All', count: counts.all },
    { value: 'late' as const, label: 'Overdue', count: counts.late },
    { value: 'client' as const, label: 'Waiting for client', count: counts.client },
    { value: 'cicd' as const, label: 'CI/CD on', count: counts.cicd },
    ...(counts.mine ? [{ value: 'mine' as const, label: 'Mine', count: counts.mine }] : []),
  ];

  return (
    <Screen title="DevOps board" sub={`${all.length} projects · ${counts.late} overdue`} actions={actions} testID="screen-devops">
      <SearchField value={q} onChange={setQ} placeholder="Search projects" testID="dv-search" />
      <FilterChips options={chips} value={f} onChange={setF} testID="dv-chip" />
      <Segmented
        options={[
          { value: 'phase', label: 'Status' },
          { value: 'owner', label: 'Owner' },
          { value: 'dev', label: 'Dev phase' },
        ]}
        value={g}
        onChange={setG}
        testID="dv-group"
      />
      {groups.map((G) => (
        <Block key={G.name} title={G.name} sub={plural(G.items.length, 'project')} testID={`dv-group-${G.name}`}>
          <Rows>
            {G.items.map((d) => (
              <DevopsRow key={d.key} d={d} />
            ))}
          </Rows>
        </Block>
      ))}
      {groups.length ? null : <EmptyBlock text="No projects match these filters." testID="dv-empty" />}
      {adding ? <DvNewSheet visible onClose={() => setAdding(false)} /> : null}
    </Screen>
  );
}

import { useMemo, useState } from 'react';

import { Block, EmptyBlock, FilterChips, ProgressList, Rows, Screen, Segmented, TicketRow } from '@/components';
import { myTickets } from '@/data/selectors';
import { useStoreState } from '@/data/store';
import { colors } from '@/theme';
import { useRootActions } from '@/nav/useRootActions';

import { filterView, groupTickets, isOpenCritical, myEpics, mySprints, needsYouNow, type Grouping, type MyView } from './myTickets';

/** S5-MYTICKETS My tickets (V-30): segment, grouping chips, groups, My sprints, My epics. */
export function MyTicketsScreen() {
  const s = useStoreState();
  const actions = useRootActions();
  const [v, setV] = useState<MyView>('now');
  const [g, setG] = useState<Grouping>('due');
  const A = useMemo(() => myTickets(s), [s]);
  const groups = useMemo(() => groupTickets(s, filterView(A, v), g), [s, A, v, g]);
  const sprints = useMemo(() => mySprints(s, A), [s, A]);
  const epics = useMemo(() => myEpics(s, A), [s, A]);
  const open = A.filter((t) => t.st !== 'done').length;
  return (
    <Screen title="My tickets" sub={`${open} open`} actions={actions} testID="screen-tickets">
      <Segmented<MyView>
        options={[
          { value: 'now', label: 'Needs you now', count: A.filter(needsYouNow).length || undefined },
          { value: 'crit', label: 'Critical', count: A.filter(isOpenCritical).length || undefined },
          { value: 'all', label: 'All my tickets' },
        ]}
        value={v}
        onChange={setV}
        testID="seg"
      />
      <FilterChips<Grouping>
        options={[
          { value: 'due', label: 'Group by due date' },
          { value: 'sprint', label: 'Group by sprint' },
          { value: 'proj', label: 'Group by project' },
        ]}
        value={g}
        onChange={setG}
        testID="chip"
      />
      {groups.map((gr) => (
        <Block key={gr.title} title={gr.title} sub={gr.sub} testID={`group-${gr.title}`}>
          <Rows>
            {gr.tickets.map((t) => (
              <TicketRow key={t.key} ticket={t} />
            ))}
          </Rows>
        </Block>
      ))}
      {!groups.length ? <EmptyBlock text="No tickets match these filters." testID="tickets-empty" /> : null}
      <Block title="My sprints" testID="my-sprints">
        <ProgressList
          items={sprints.map((x) => ({ title: x.title, used: x.done, of: x.total, caption: x.caption, color: colors.green }))}
          empty="No active sprints."
        />
      </Block>
      <Block title="My epics" testID="my-epics">
        <ProgressList items={epics.map((x) => ({ title: x.title, used: x.done, of: x.total, caption: x.caption, color: colors.green }))} empty="No epics." />
      </Block>
    </Screen>
  );
}

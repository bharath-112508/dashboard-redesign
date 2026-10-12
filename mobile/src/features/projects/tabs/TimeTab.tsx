import { useMemo } from 'react';

import { Avatar, Block, Button, ButtonRow, KpiGrid, ProgressList, Row, Rows, showToast } from '@/components';
import { csv, fmtL, hm } from '@/data/format';
import { projValue, tkOrSub, type ProjectView } from '@/data/selectors';
import { useStoreState } from '@/data/store';
import { shareCsv } from '@/features/time/csv';
import { openLog } from '@/features/time/openLog';
import { colors } from '@/theme';

import { minutesByPerson, projectEntries } from '../derive';

/** Time tab (staff): KPIs, Log time (preset project) and CSV download, contributors, last 25 entries. */
export function TimeTab({ p }: { p: ProjectView }) {
  const state = useStoreState();
  const E = useMemo(() => projectEntries(state, p), [state, p]);
  const bill = E.filter((e) => e.bill).reduce((a, e) => a + e.min, 0);
  const non = E.filter((e) => !e.bill).reduce((a, e) => a + e.min, 0);
  const by = minutesByPerson(E);
  const max = Math.max(1, ...by.map((x) => x.min));
  const download = async () => {
    const rows = [['Date', 'Person', 'Ticket', 'Task', 'Billable', 'Minutes', 'Note'], ...E.map((e) => [e.date, e.who, e.key || '', e.task, e.bill ? 'Yes' : 'No', e.min, e.note || ''])];
    const ok = await shareCsv(`${p.name} time.csv`, csv(rows));
    if (!ok) showToast('Could not export the file');
  };
  return (
    <>
      <KpiGrid
        items={[
          { label: 'Total logged', value: hm(bill + non), dot: colors.ink },
          { label: 'Billable', value: hm(bill), sub: `${Math.round((bill / Math.max(1, bill + non)) * 100)}%`, dot: colors.primary },
          { label: 'Non-billable', value: hm(non), dot: colors.violet },
          { label: 'Entries', value: String(E.length), dot: colors.faint },
        ]}
        testID="time-kpis"
      />
      <ButtonRow>
        <Button title="Log time" icon="timer" onPress={() => openLog({ proj: projValue(p) })} testID="project-log-time" />
        <Button title="Download" kind="s" icon="download" onPress={download} testID="project-time-download" />
      </ButtonRow>
      <Block title="Contributors">
        <ProgressList items={by.map((x) => ({ title: x.who, used: x.min, of: max, value: hm(x.min) }))} empty="No time logged in this range." />
      </Block>
      <Block title="Entries">
        <Rows empty="No time logged yet." testID="time-entries">
          {E.slice(0, 25).map((e) => (
            <Row
              key={e.id}
              lead={<Avatar name={e.who} />}
              title={e.task}
              sub={`${fmtL(e.date)} · ${e.who}${e.key ? ` · ${tkOrSub(state, e.key)?.key ?? e.key}` : ''}`}
              right={hm(e.min)}
              rightColor={colors.ink}
              rightWeight={700}
              meta={[{ icon: e.bill ? 'badge-dollar-sign' : 'circle-minus', text: e.bill ? 'Billable' : 'Non-billable', color: e.bill ? colors.primaryInk : colors.violetInk }]}
            />
          ))}
        </Rows>
      </Block>
    </>
  );
}

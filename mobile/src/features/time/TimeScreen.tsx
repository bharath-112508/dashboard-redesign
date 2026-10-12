import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Buttons';
import { Block } from '@/components/Card';
import { DayStrip } from '@/components/DayStrip';
import { EmptyBlock } from '@/components/EmptyBlock';
import { SelectField } from '@/components/fields';
import { HeatTable } from '@/components/HeatTable';
import { KpiGrid } from '@/components/KpiGrid';
import { Rows } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { FilterChips, Segmented } from '@/components/Segmented';
import { showToast } from '@/components/Toast';
import { WeekBars } from '@/components/WeekBars';
import { TODAY } from '@/data/clock';
import { addD, fmt, fmtL, hm, monday } from '@/data/format';
import { isFreelancer, me, myEntries, projOpts, weekBars } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { useRootActions } from '@/nav/useRootActions';
import { colors } from '@/theme';

import { shareCsv } from './csv';
import { EntryRow } from './EntryRow';
import { useTimeLabels } from './labels';
import { openLog } from './openLog';
import { billMin, dayStrip, daySummary, groupEntries, inRange, heatRows, myCsv, newestFirst, periodRange, slug, sum, weekSummary, type GroupBy, type Period } from './timeMath';

type View_ = 'log' | 'week' | 'hist';

/** S5-TIME "My timesheet": Log (day strip) · Week (bars, heat table) · History (filters, CSV). */
export function TimeScreen() {
  const u = useAppState(me);
  const mine = useAppState(myEntries);
  const actions = useRootActions();
  const free = isFreelancer(u);
  const [v, setV] = useState<View_>('log');
  return (
    <Screen title="My timesheet" sub={u ? u.name + (free ? ' · Freelancer' : '') : ''} actions={actions} testID="screen-time">
      <Segmented
        options={[
          { value: 'log', label: 'Log' },
          { value: 'week', label: 'Week' },
          { value: 'hist', label: 'History' },
        ]}
        value={v}
        onChange={setV}
        testID="time-seg"
      />
      {v === 'log' ? <LogView free={free} mine={mine} /> : v === 'week' ? <WeekView free={free} mine={mine} name={u?.name ?? ''} /> : <HistoryView mine={mine} name={u?.name ?? ''} />}
    </Screen>
  );
}

type Mine = ReturnType<typeof myEntries>;

function LogView({ free, mine }: { free: boolean; mine: Mine }) {
  const [day, setDay] = useState(TODAY);
  const L = useLabels();
  const strip = dayStrip(mine, day, free);
  const d = daySummary(mine, day, free);
  const wk = monday(day);
  const W = inRange(mine, wk, addD(wk, 6));
  const de = newestFirst(mine.filter((e) => e.date === day)).reverse();
  return (
    <>
      <DayStrip days={strip} selected={day} onSelect={setDay} />
      <KpiGrid
        testID="time-kpis"
        items={[
          { label: d.label, value: d.value, of: d.of, sub: d.sub, dot: colors.ink, color: d.short ? colors.destructiveInk : colors.ink, testID: 'kpi-day' },
          { label: 'This week', value: hm(sum(W)), of: free ? '' : '/ 40h', sub: `Billable ${hm(billMin(W))}`, dot: colors.primary, testID: 'kpi-week' },
        ]}
      />
      <Button title="Log time" icon="plus" onPress={() => openLog({ date: day })} testID="time-log" />
      <Block title="Entries">
        <Rows empty="Nothing logged for this day yet." testID="time-entries">
          {de.map((e) => (
            <EntryRow key={e.id} e={e} keyText={L.key(e.key)} sub={L.proj(e.proj) + (e.note ? ` · ${e.note}` : '')} onPress={() => openLog({ id: e.id })} />
          ))}
        </Rows>
      </Block>
    </>
  );
}

function WeekView({ free, mine, name }: { free: boolean; mine: Mine; name: string }) {
  const [wo, setWo] = useState(0);
  const L = useLabels();
  const wk = addD(monday(TODAY), wo * 7);
  const w = weekSummary(mine, wk, free);
  const bars = useAppState((s) => weekBars(s, wk, name, { idle: !free }));
  const heat = heatRows(mine, wk, L.proj, L.key);
  return (
    <>
      <View style={styles.nav}>
        <View style={styles.navSide}>
          <Button title="" icon="chevron-left" kind="s" label="Previous week" onPress={() => setWo(wo - 1)} testID="week-prev" />
        </View>
        <View style={styles.navMid}>
          <Button title={`${fmt(w.days[0])} – ${fmt(w.days[6])}`} kind="s" label="This week" onPress={() => setWo(0)} testID="week-now" />
        </View>
        <View style={styles.navSide}>
          <Button title="" icon="chevron-right" kind="s" label="Next week" disabled={wo >= 0} onPress={() => setWo(Math.min(0, wo + 1))} testID="week-next" />
        </View>
      </View>
      <KpiGrid
        testID="week-kpis"
        items={[
          { label: 'Total', value: hm(w.total), of: free ? '' : '/ 40h', dot: colors.ink },
          { label: 'Billable', value: hm(w.bill), dot: colors.primary },
          { label: 'Non-billable', value: hm(w.non), dot: colors.violet },
          free
            ? { label: 'Freelancer', value: 'No idle', sub: 'Idle time is skipped', dot: colors.faint, testID: 'kpi-idle' }
            : { label: 'Idle', value: hm(w.idle), sub: 'this week', dot: colors.red, color: w.idle ? colors.redInk : colors.ink, testID: 'kpi-idle' },
        ]}
      />
      <Block title="Daily total" sub="8h required a day">
        <WeekBars days={bars} idle={!free} foot={hm(w.total)} testID="week-bars" />
      </Block>
      <Block title="Week overview" sub="Hours per project and task">
        {heat.length ? <HeatTable rows={heat} testID="week-heat" /> : <EmptyBlock text="Nothing logged this week." />}
      </Block>
    </>
  );
}

function HistoryView({ mine, name }: { mine: Mine; name: string }) {
  const [per, setPer] = useState<Period>('month');
  const [gb, setGb] = useState<GroupBy>('day');
  const [pf, setPf] = useState('all');
  const L = useLabels();
  const opts = useAppState(projOpts);
  const [r0, r1] = periodRange(per);
  const list = useMemo(() => newestFirst(inRange(mine, r0, r1).filter((e) => pf === 'all' || e.proj === pf)), [mine, r0, r1, pf]);
  const groups = groupEntries(list, gb);
  const download = async () => {
    const ok = await shareCsv(`timesheet-${slug(name)}.csv`, myCsv(list, L.proj, L.key));
    if (!ok) showToast('Could not export the CSV');
  };
  return (
    <>
      <FilterChips
        options={[
          { value: 'week', label: 'This week' },
          { value: 'last', label: 'Last week' },
          { value: 'month', label: 'This month' },
          { value: 'all', label: 'All time' },
        ]}
        value={per}
        onChange={(x) => setPer(x as Period)}
        testID="hist-per"
      />
      <SelectField label="Project" value={pf} options={[{ value: 'all', label: 'All projects' }, ...opts]} onChange={setPf} testID="hist-project" />
      <Segmented
        options={[
          { value: 'day', label: 'By day' },
          { value: 'proj', label: 'By project' },
          { value: 'task', label: 'By task' },
        ]}
        value={gb}
        onChange={setGb}
        testID="hist-group"
      />
      <KpiGrid
        testID="hist-kpis"
        items={[
          { label: 'Total', value: hm(sum(list)), sub: `${list.length} entries`, dot: colors.ink },
          { label: 'Billable', value: hm(billMin(list)), dot: colors.primary },
        ]}
      />
      {groups.map((g) => (
        <Block key={g.key} title={gb === 'day' ? fmtL(g.key) : gb === 'proj' ? L.proj(g.key) : L.key(g.key) || g.key} sub={hm(g.total)} testID="hist-group-block">
          <Rows>
            {g.entries.map((e) => (
              <EntryRow
                key={e.id}
                e={e}
                weight={700}
                tile={false}
                keyText={L.key(e.key)}
                sub={(gb === 'day' ? L.proj(e.proj) : fmtL(e.date)) + (e.note ? ` · ${e.note}` : '')}
                onPress={() => openLog({ id: e.id })}
              />
            ))}
          </Rows>
        </Block>
      ))}
      {list.length ? null : <EmptyBlock text="No entries match these filters." testID="hist-empty" />}
      <Button title="Download CSV" icon="download" kind="s" onPress={download} testID="hist-csv" />
    </>
  );
}

const useLabels = useTimeLabels;

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', gap: 8 },
  navSide: { width: 56 },
  navMid: { flex: 1 },
});

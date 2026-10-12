import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { DarkButton } from '@/components/Buttons';
import { Card } from '@/components/Card';
import { ChipRow } from '@/components/Controls';
import { EmptyState } from '@/components/EmptyState';
import { Screen } from '@/components/Screen';
import { showToast } from '@/components/Toast';
import { Txt } from '@/components/Txt';
import { hm } from '@/data/format';
import { me } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { colors, motion } from '@/theme';

import { shareCsv } from './csv';
import { historyCsv, historyRows, historyView, type HistoryFilter } from './selectors';
import { BillChip } from './BillChip';

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'bill', label: 'Billable' },
  { key: 'non', label: 'Non-billable' },
];

/** S-HISTORY Time history: filter chips, totals, Download CSV, day cards (M-42). */
export function HistoryScreen() {
  const name = useAppState((s) => me(s)?.name ?? '');
  const all = useAppState(historyRows);
  const filter = useAppState((s) => s.ui.historyFilter);
  const project = useAppState((s) => s.ui.historyProject);
  const { setUi } = useActions();
  const view = useMemo(() => historyView(all, filter, project), [all, filter, project]);
  const proj = view.projects.includes(project) ? project : 'all';

  const download = async () => {
    const ok = await shareCsv(`timesheet-${name.toLowerCase().replace(/\s+/g, '-')}.csv`, historyCsv(view.rows));
    if (ok) showToast('CSV downloaded');
  };

  return (
    <Screen title="Time history" gap={12} testID="screen-history">
      <ChipRow label="Billing filter" options={FILTERS} value={filter} onChange={(k) => setUi({ historyFilter: k })} />
      <ChipRow
        label="Project filter"
        options={view.projects.map((p) => ({ key: p, label: p === 'all' ? 'All projects' : p }))}
        value={proj}
        onChange={(k) => setUi({ historyProject: k })}
      />
      <View style={styles.totals}>
        <Txt v="rowTitle" w={700} color={colors.ink3} style={styles.flex} testID="history-total">
          {`${hm(view.total)} · ${view.rows.length} entries`}
        </Txt>
        <DarkButton label="Download CSV" icon="download" onPress={download} style={styles.dl} testID="history-download" />
      </View>

      {view.days.length === 0 ? (
        <EmptyState icon="history" text="No entries match these filters." />
      ) : (
        view.days.map((d, i) => (
          <Animated.View key={d.d} style={motion.fadeUp(Math.min(i, 8), 0.05, 0.04)}>
            <Card pad={0} style={styles.card} testID="history-day">
              <View style={styles.dayHead}>
                <Txt v="rowTitle" w={800}>
                  {d.day}
                </Txt>
                <Txt v="rowTitle" w={800}>
                  {hm(d.total)}
                </Txt>
              </View>
              {d.rows.map((r) => (
                <View key={r.id} style={styles.row} testID="history-row">
                  <View style={styles.rowText}>
                    <Txt v="rowTitle" numberOfLines={1}>
                      {r.work}
                    </Txt>
                    <Txt v="meta" w={400} color={colors.ink3} numberOfLines={1}>
                      {r.project}
                    </Txt>
                  </View>
                  <BillChip bill={r.bill} />
                  <Txt v="rowTitle" w={800} align="right" style={styles.hours}>
                    {hm(r.h)}
                  </Txt>
                </View>
              ))}
            </Card>
          </Animated.View>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  totals: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dl: { paddingHorizontal: 18, height: 38, borderRadius: 19 },
  card: { overflow: 'hidden' },
  dayHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.divider },
  rowText: { flex: 1, gap: 3, minWidth: 0 },
  hours: { minWidth: 50 },
});

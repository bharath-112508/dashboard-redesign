import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Card, ListCard } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { Txt } from '@/components/Txt';
import { hm } from '@/data/format';
import type { TeamRow } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { WeekSwitcher } from '@/features/time/WeekSwitcher';
import { colors, motion } from '@/theme';

import { barWidths, teamRows } from './selectors';

/** S-TEAM Team hours (pm, admin, super): week switcher, totals, one row per person (M-39). */
export function TeamScreen() {
  const offset = useAppState((s) => s.ui.teamOffset);
  const view = useAppState((s) => teamRows(s, s.ui.teamOffset));
  const { setUi } = useActions();
  const tiles: [string, number][] = [
    ['Logged', view.totals.logged],
    ['Billable', view.totals.billable],
    ['Idle', view.totals.idle],
  ];
  return (
    <Screen title="Team hours" gap={12} testID="screen-team">
      <WeekSwitcher offset={offset} onChange={(o) => setUi({ teamOffset: o })} shape="round" />
      <View style={styles.tiles}>
        {tiles.map(([l, v], i) => (
          <Animated.View key={l} style={[styles.flex, motion.fadeUp(i, 0.05, 0.05)]}>
            <Card pad={12} style={styles.tile} testID={`team-total-${l.toLowerCase()}`}>
              <Txt v="meta" color={colors.ink3}>
                {l}
              </Txt>
              <Txt v="section" numberOfLines={1} adjustsFontSizeToFit>
                {hm(v)}
              </Txt>
            </Card>
          </Animated.View>
        ))}
      </View>
      <ListCard>
        {view.rows.map((r, i) => (
          <MemberRow key={r.name} row={r} first={i === 0} />
        ))}
      </ListCard>
    </Screen>
  );
}

function MemberRow({ row, first }: { row: TeamRow; first: boolean }) {
  const w = barWidths(row);
  const highIdle = row.idle !== null && row.idle > 4;
  return (
    <View style={[styles.row, !first && styles.divider]} testID={`team-row-${row.name}`}>
      <View style={styles.head}>
        <Avatar name={row.name} size={36} radius={18} />
        <View style={styles.flex}>
          <Txt v="rowTitle" w={800} numberOfLines={1}>
            {row.name}
          </Txt>
          <Txt v="meta" w={400} color={colors.ink3} numberOfLines={1}>
            {`${row.roleLabel} · ${row.isFree ? 'No target' : hm(row.target)}`}
          </Txt>
        </View>
        <View style={styles.right}>
          <Txt v="rowTitle" w={800} testID="team-logged">
            {hm(row.logged)}
          </Txt>
          <Txt v="meta" w={highIdle ? 800 : 600} color={highIdle ? colors.danger : colors.ink} testID="team-idle">
            {`Idle ${row.idle === null ? '—' : hm(row.idle)}`}
          </Txt>
        </View>
      </View>
      <View
        style={styles.bar}
        accessible
        accessibilityLabel={`${row.name}: billable ${hm(row.billable)}, logged ${hm(row.logged)}`}
      >
        <View style={[styles.fill, { width: `${w.logged}%`, backgroundColor: colors.teamLogged }]} />
        <View style={[styles.fill, { width: `${w.billable}%`, backgroundColor: colors.primary }]} />
      </View>
      <View style={styles.legend}>
        <Legend color={colors.primary} label="Billable" value={hm(row.billable)} />
        <Legend color={colors.teamLogged} label="Logged" value={hm(row.logged)} />
      </View>
    </View>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.square, { backgroundColor: color }]} />
      <Txt v="meta" w={500} color={colors.ink3}>
        {`${label}  ${value}`}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { gap: 4 },
  row: { padding: 14, gap: 10 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  right: { alignItems: 'flex-end', gap: 1 },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.track, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4 },
  legend: { flexDirection: 'row', gap: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  square: { width: 8, height: 8, borderRadius: 2 },
});

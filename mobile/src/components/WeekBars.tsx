import { StyleSheet, View } from 'react-native';
import Svg, { Defs, Pattern, Rect } from 'react-native-svg';

import { hm } from '@/data/format';
import { colors } from '@/theme';

import { Card } from './Card';
import { Txt } from './Txt';

export interface WeekBar {
  /** "Mon" */
  day: string;
  billMin: number;
  nonMin: number;
  idleMin: number;
}

function Hatch() {
  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
      <Defs>
        <Pattern id="idle" width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <Rect width={8} height={8} fill={colors.idleHatch2} />
          <Rect width={4} height={8} fill={colors.idleHatch} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#idle)" />
    </Svg>
  );
}

/**
 * Week bars (SPEC §6.2): 7 columns 120h, stacked idle (hatched) / non-billable (violet) /
 * billable (blue), day and total labels, legend and a foot total. Freelancers: `idle`
 * false hides idle. Day totals never wrap (long values such as "26h 45m" use a smaller size).
 */
export function WeekBars({ days, foot, idle = true, testID }: { days: WeekBar[]; foot?: string; idle?: boolean; testID?: string }) {
  const cap = Math.max(480, ...days.map((d) => d.billMin + d.nonMin));
  const pc = (m: number) => `${Math.round((m / cap) * 100)}%` as const;
  return (
    <Card pad="lg" testID={testID}>
      <View style={styles.bars}>
        {days.map((d, i) => (
          <View key={i} style={styles.col}>
            {idle && d.idleMin ? (
              <View style={{ height: pc(d.idleMin), overflow: 'hidden' }}>
                <Hatch />
              </View>
            ) : null}
            {d.nonMin ? <View style={{ height: pc(d.nonMin), backgroundColor: colors.violet }} /> : null}
            {d.billMin ? <View style={{ height: pc(d.billMin), backgroundColor: colors.primary }} /> : null}
          </View>
        ))}
      </View>
      <View style={styles.labels}>
        {days.map((d, i) => {
          const t = d.billMin + d.nonMin;
          const text = t ? hm(t) : '–';
          return (
            <View key={i} style={styles.label}>
              <Txt v="tab" w={700} color={colors.ink3} numberOfLines={1}>
                {d.day}
              </Txt>
              <Txt v="tiny" w={600} color={t ? colors.ink : colors.faint} numberOfLines={1} style={text.length > 6 ? styles.long : null}>
                {text}
              </Txt>
            </View>
          );
        })}
      </View>
      <View style={styles.legend}>
        <Legend color={colors.primary} text="Billable" />
        <Legend color={colors.violet} text="Non-billable" />
        {idle ? <Legend color={colors.idleHatch} text="Idle" /> : null}
        {foot ? (
          <Txt v="small" w={700} style={styles.foot}>
            {foot}
          </Txt>
        ) : null}
      </View>
    </Card>
  );
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <Txt v="small" w={400} color={colors.ink3}>
        {text}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  bars: { flexDirection: 'row', gap: 6, height: 120, alignItems: 'flex-end' },
  col: { flex: 1, height: '100%', justifyContent: 'flex-end', gap: 2, borderRadius: 6, backgroundColor: colors.bg, overflow: 'hidden' },
  labels: { marginTop: 6, flexDirection: 'row', gap: 6 },
  // a label may use the gaps next to its column, so "26h 45m" stays on one line
  label: { flex: 1, minWidth: 0, marginHorizontal: -3, alignItems: 'center' },
  long: { fontSize: 9.5, letterSpacing: -0.3 },
  legend: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 9, height: 9, borderRadius: 2 },
  foot: { marginLeft: 'auto' },
});


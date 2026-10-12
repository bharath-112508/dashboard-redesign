import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Card } from './Card';
import { EmptyBlock } from './EmptyBlock';
import { Press } from './Press';
import { Txt } from './Txt';

export interface GanttItem {
  title: string;
  /** right text (dates) */
  right?: string;
  rightColor?: string;
  /** bar start and width in % of the range (0–100) */
  left: number;
  width: number;
  color: string;
  onPress?: () => void;
}

/**
 * Gantt (SPEC §6.2): 4 ticks, a 10h track #F1F4F8 r5 per item with a positioned bar and
 * a 2px orange today line. Positions are computed by the caller (W2 Timeline tab).
 */
export function Gantt({ ticks, items, now, empty, testID }: { ticks: string[]; items: GanttItem[]; now?: number; empty?: string; testID?: string }) {
  if (!items.length) return <EmptyBlock text={empty ?? 'No dates planned yet.'} />;
  return (
    <Card style={styles.card} testID={testID}>
      <View style={styles.ticks}>
        {ticks.map((t, i) => (
          <Txt key={i} v="tiny" color={colors.ink3}>
            {t}
          </Txt>
        ))}
      </View>
      {items.map((g, i) => {
        const body = (
          <>
            <View style={styles.top}>
              <Txt v="sub" w={600} numberOfLines={1} style={styles.title}>
                {g.title}
              </Txt>
              {g.right ? (
                <Txt v="sub" w={600} color={g.rightColor ?? colors.ink3}>
                  {g.right}
                </Txt>
              ) : null}
            </View>
            <View style={styles.track}>
              <View style={[styles.bar, { left: `${g.left}%`, width: `${Math.max(1.5, g.width)}%`, backgroundColor: g.color }]} />
              {now !== undefined ? <View style={[styles.now, { left: `${now}%` }]} /> : null}
            </View>
          </>
        );
        return g.onPress ? (
          <Press key={i} label={g.title} onPress={g.onPress} style={styles.item}>
            {body}
          </Press>
        ) : (
          <View key={i} style={styles.item}>
            {body}
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 12, paddingHorizontal: 14 },
  ticks: { flexDirection: 'row', justifyContent: 'space-between' },
  item: { marginTop: 10 },
  top: { flexDirection: 'row', gap: 8 },
  title: { flex: 1, minWidth: 0 },
  track: { marginTop: 5, height: 10, borderRadius: 5, backgroundColor: colors.trackSoft },
  bar: { position: 'absolute', top: 0, bottom: 0, borderRadius: 5 },
  now: { position: 'absolute', top: -3, bottom: -3, width: 2, backgroundColor: colors.orange },
});

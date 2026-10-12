import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Badge, type BadgeTone } from './Bits';
import { Card } from './Card';
import { EmptyBlock } from './EmptyBlock';
import { Press } from './Press';
import { Txt } from './Txt';

export interface StepRow {
  title: string;
  /** status pill */
  status: string;
  tone: BadgeTone;
  /** step states, 4 per row: done / current / future */
  steps: ('done' | 'current' | 'future')[];
  onPress?: () => void;
}

const STEP_COLOUR = { done: colors.green, current: colors.amberDot, future: colors.ringCard } as const;

/** DevOps step bars (SPEC §6.2): per row a title, a status pill and 4 segments. */
export function StepBars({ rows, empty, testID }: { rows: StepRow[]; empty?: string; testID?: string }) {
  if (!rows.length) return <EmptyBlock text={empty ?? 'Nothing here yet.'} />;
  return (
    <Card style={styles.card} testID={testID}>
      {rows.map((x, i) => {
        const body = (
          <>
            <View style={styles.top}>
              <Txt v="item" numberOfLines={1} style={styles.title}>
                {x.title}
              </Txt>
              <Badge label={x.status} tone={x.tone} />
            </View>
            <View style={styles.steps}>
              {x.steps.map((s, j) => (
                <View key={j} style={[styles.step, { backgroundColor: STEP_COLOUR[s] }]} />
              ))}
            </View>
          </>
        );
        const style = [styles.item, i ? styles.divider : null];
        return x.onPress ? (
          <Press key={i} label={x.title} onPress={x.onPress} style={style}>
            {body}
          </Press>
        ) : (
          <View key={i} style={style}>
            {body}
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 4, paddingHorizontal: 14 },
  item: { paddingVertical: 11 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, minWidth: 0 },
  steps: { marginTop: 8, flexDirection: 'row', gap: 4 },
  step: { flex: 1, height: 6, borderRadius: 3 },
});

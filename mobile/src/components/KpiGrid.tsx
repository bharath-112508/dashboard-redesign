import { StyleSheet, View } from 'react-native';

import { colors, radii } from '@/theme';

import { Dot } from './Bits';
import { Press } from './Press';
import { Txt } from './Txt';

export interface Kpi {
  label: string;
  value: string;
  /** "/ 40h" */
  of?: string;
  sub?: string;
  /** dot colour, default blue */
  dot?: string;
  /** value colour (red for overdue) */
  color?: string;
  onPress?: () => void;
  testID?: string;
}

/** KPI grid (SPEC §6.2): 2 columns, gap 8; tile r16 p13/14, dot + label 12/600, value 21/800, sub 11.5. */
export function KpiGrid({ items, testID }: { items: Kpi[]; testID?: string }) {
  return (
    <View style={styles.grid} testID={testID}>
      {items.map((k, i) => {
        const body = (
          <>
            <View style={styles.labelRow}>
              <Dot color={k.dot ?? colors.primary} size={7} />
              <Txt v="meta" w={600} color={colors.ink3} numberOfLines={1} style={styles.shrink}>
                {k.label}
              </Txt>
            </View>
            <View style={styles.valueRow}>
              <Txt v="kpi" color={k.color ?? colors.ink} numberOfLines={1}>
                {k.value}
              </Txt>
              {k.of ? (
                <Txt v="meta" w={400} color={colors.ink3} numberOfLines={1}>
                  {k.of}
                </Txt>
              ) : null}
            </View>
            {k.sub ? (
              <Txt v="small" w={400} color={colors.ink3} numberOfLines={1} style={styles.sub}>
                {k.sub}
              </Txt>
            ) : null}
          </>
        );
        return k.onPress ? (
          <Press key={i} label={`${k.label}: ${k.value}`} onPress={k.onPress} style={styles.tile} testID={k.testID}>
            {body}
          </Press>
        ) : (
          <View key={i} style={styles.tile} testID={k.testID}>
            {body}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    minWidth: 0,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.ringCard,
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
  valueRow: { marginTop: 6, flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  sub: { marginTop: 2 },
});

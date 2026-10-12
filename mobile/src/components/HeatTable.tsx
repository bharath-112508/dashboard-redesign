import { ScrollView, StyleSheet, View } from 'react-native';

import { hm } from '@/data/format';
import { colors, heatColor } from '@/theme';

import { Card } from './Card';
import { Txt } from './Txt';

export interface HeatRow {
  title: string;
  sub?: string;
  /** minutes per day, Mon–Sun (7 values) */
  cells: number[];
  /** bold row (totals) */
  bold?: boolean;
}

/**
 * Heat table (SPEC §6.2): rows of project/task × M–S with a total column; the cell colour
 * is rgba(72,112,232,.18–.90) by value against the largest cell.
 */
export function HeatTable({ rows, days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'], testID }: { rows: HeatRow[]; days?: string[]; testID?: string }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.cells));
  return (
    <Card style={styles.card} testID={testID}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.inner}>
        <View style={styles.table}>
          <View style={styles.line}>
            <Txt v="tab" w={700} color={colors.ink3} style={styles.name}>
              Project / task
            </Txt>
            {days.map((d, i) => (
              <Txt key={i} v="tab" w={700} color={colors.ink3} style={styles.cellHead}>
                {d}
              </Txt>
            ))}
            <Txt v="tab" w={700} color={colors.ink3} style={styles.total}>
              Total
            </Txt>
          </View>
          {rows.map((r, i) => (
            <View key={i} style={[styles.line, styles.rowGap]}>
              <View style={styles.name}>
                <Txt v="sub" w={r.bold ? 800 : 600} numberOfLines={1}>
                  {r.title}
                </Txt>
                {r.sub ? (
                  <Txt v="tab" w={400} color={colors.ink3} numberOfLines={1}>
                    {r.sub}
                  </Txt>
                ) : null}
              </View>
              {r.cells.map((m, j) => (
                <View key={j} style={[styles.cell, { backgroundColor: m ? heatColor(m / max) : colors.trackSoft }]}>
                  <Txt v="tiny" color={m / max > 0.5 ? colors.white : colors.ink}>
                    {m ? (m / 60).toFixed(m % 60 ? 1 : 0) : ''}
                  </Txt>
                </View>
              ))}
              <Txt v="meta" w={800} style={styles.total}>
                {hm(r.cells.reduce((a, b) => a + b, 0))}
              </Txt>
            </View>
          ))}
        </View>
      </ScrollView>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingTop: 12, paddingBottom: 8 },
  inner: { paddingHorizontal: 12, flexGrow: 1 },
  table: { flex: 1, minWidth: 330 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rowGap: { marginTop: 4 },
  name: { flex: 1, minWidth: 80 },
  cellHead: { width: 30, textAlign: 'center' },
  cell: { width: 30, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  total: { width: 44, textAlign: 'right' },
});

import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Dot } from './Bits';
import { Card } from './Card';
import { Icon, type IconName } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

export interface FieldItem {
  label: string;
  /** '' or null shows "—" */
  value: string | number | null | undefined;
  /** value colour (red when late) */
  color?: string;
  /** dot before the value (status, priority) */
  dot?: string;
  /** chevron-right by default; 'pencil' for dates */
  icon?: IconName;
  onPress?: () => void;
  testID?: string;
}

/**
 * Field list (SPEC §6.2): rows min 46h, label 118w 12.5/600, value right-aligned 13.5/600
 * with an optional dot, chevron or pencil when tappable.
 */
export function FieldList({ items, testID }: { items: (FieldItem | null | false | undefined)[]; testID?: string }) {
  const L = items.filter(Boolean) as FieldItem[];
  return (
    <Card testID={testID}>
      {L.map((f, i) => {
        const v = f.value === '' || f.value == null ? '—' : String(f.value);
        const body = (
          <>
            <Txt v="sub" w={600} color={colors.ink3} style={styles.label}>
              {f.label}
            </Txt>
            <View style={styles.value}>
              {f.dot ? <Dot color={f.dot} size={7} /> : null}
              <Txt v="item" color={f.color ?? colors.ink} align="right" style={styles.valueText}>
                {v}
              </Txt>
            </View>
            {f.onPress ? <Icon name={f.icon ?? 'chevron-right'} size={15} color={colors.faint} /> : null}
          </>
        );
        const style = [styles.row, i ? styles.divider : null];
        return f.onPress ? (
          <Press key={i} label={`${f.label}: ${v}`} onPress={f.onPress} style={style} testID={f.testID}>
            {body}
          </Press>
        ) : (
          <View key={i} style={style} testID={f.testID}>
            {body}
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, paddingVertical: 10, paddingHorizontal: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  label: { width: 118 },
  value: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  valueText: { flexShrink: 1 },
});

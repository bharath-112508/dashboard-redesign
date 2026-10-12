import { StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Press } from '@/components/Press';
import { Txt } from '@/components/Txt';
import { weekRange } from '@/data/selectors';
import { colors, pressScale, radii } from '@/theme';

export interface WeekSwitcherProps {
  offset: number;
  onChange: (offset: number) => void;
  /** show "This week" / "Last week" / "N weeks ago" under the range (Timesheet) */
  showRelative?: boolean;
  /** square buttons (Timesheet, radius 12) or round (Team hours) */
  shape?: 'square' | 'round';
}

/**
 * Previous / next week buttons around the week range (M-18, M-39).
 * Next is disabled (35% opacity) on the current week.
 */
export function WeekSwitcher({ offset, onChange, showRelative, shape = 'square' }: WeekSwitcherProps) {
  const wk = weekRange(offset);
  const canNext = offset < 0;
  const btn = [styles.btn, shape === 'round' ? styles.round : null];
  return (
    <View style={styles.row}>
      <Press label="Previous week" onPress={() => onChange(offset - 1)} scale={pressScale.tab} style={btn} testID="week-prev">
        <Icon name="chevron-left" size={20} color={colors.ink} strokeWidth={2.4} />
      </Press>
      <View style={styles.mid} accessible accessibilityRole="text" testID="week-range">
        <Txt v="titleSm" w={800} align="center">
          {wk.label}
        </Txt>
        {showRelative ? (
          <Txt v="bodySm" w={500} color={colors.ink3} align="center" testID="week-rel">
            {wk.rel}
          </Txt>
        ) : null}
      </View>
      <Press
        label="Next week"
        onPress={() => canNext && onChange(offset + 1)}
        disabled={!canNext}
        scale={pressScale.tab}
        style={[btn, !canNext && styles.off]}
        testID="week-next"
      >
        <Icon name="chevron-right" size={20} color={colors.ink} strokeWidth={2.4} />
      </Press>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mid: { flex: 1, alignItems: 'center', gap: 1 },
  btn: {
    width: 40,
    height: 40,
    borderRadius: radii.iconButton,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  round: { borderRadius: 20 },
  off: { opacity: 0.35 },
});

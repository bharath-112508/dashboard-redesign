import { ScrollView, StyleSheet, View } from 'react-native';

import { colors, radii, shadows } from '@/theme';

import { Press } from './Press';
import { Txt } from './Txt';

export interface SegOption<V extends string = string> {
  value: V;
  label: string;
  /** count pill (omitted when undefined or '') */
  count?: number | string;
}

export interface SegmentedProps<V extends string> {
  options: SegOption<V>[];
  value: V;
  onChange: (v: V) => void;
  /** test ids: `${testID}-${value}` (default "seg") */
  testID?: string;
}

/**
 * Segmented control (SPEC §6.2): track #E7ECF2 r12 p4, segments 36h r9 13/700, the active
 * one white with a shadow, optional count pill 18h. Scrolls sideways when it overflows.
 */
export function Segmented<V extends string>({ options, value, onChange, testID = 'seg' }: SegmentedProps<V>) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.track} style={styles.scroll} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        const hasCount = o.count !== undefined && o.count !== '';
        return (
          <Press
            key={o.value}
            label={o.label}
            a11yRole="tab"
            selected={on}
            onPress={() => onChange(o.value)}
            style={[styles.seg, on && styles.segOn]}
            testID={`${testID}-${o.value}`}
          >
            <Txt v="label" w={700} color={on ? colors.ink : colors.ink3} numberOfLines={1}>
              {o.label}
            </Txt>
            {hasCount ? (
              <View style={[styles.count, { backgroundColor: on ? colors.primarySoft : colors.line }]}>
                <Txt v="tiny" w={700} color={colors.primaryInk} style={styles.countText}>
                  {String(o.count)}
                </Txt>
              </View>
            ) : null}
          </Press>
        );
      })}
    </ScrollView>
  );
}

export interface FilterChipsProps<V extends string> {
  options: SegOption<V>[];
  value: V;
  onChange: (v: V) => void;
  testID?: string;
}

/**
 * Filter chips (SPEC §6.2): 34h pills with a #D6DEE8 border, the selected one ink-filled,
 * counts 11.5 at .8 opacity; scrolls edge to edge (bleeds into the 16px gutter).
 */
export function FilterChips<V extends string>({ options, value, onChange, testID = 'chip' }: FilterChipsProps<V>) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bleed} contentContainerStyle={styles.chips}>
      {options.map((o) => {
        const on = o.value === value;
        const fg = on ? colors.white : colors.ink2;
        return (
          <Press
            key={o.value}
            label={o.label}
            a11yRole="button"
            selected={on}
            onPress={() => onChange(o.value)}
            style={[styles.chip, on ? styles.chipOn : null]}
            testID={`${testID}-${o.value}`}
          >
            <Txt v="label" w={600} color={fg} numberOfLines={1}>
              {o.label}
            </Txt>
            {o.count !== undefined && o.count !== '' ? (
              <Txt v="small" w={600} color={fg} style={styles.chipCount}>
                {String(o.count)}
              </Txt>
            ) : null}
          </Press>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, borderRadius: radii.input, backgroundColor: colors.segTrack },
  track: { flexGrow: 1, gap: 4, padding: 4 },
  seg: {
    flexGrow: 1,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: radii.segment,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  segOn: { backgroundColor: colors.surface, ...shadows.segmentActive },
  count: { minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  countText: { fontSize: 11 },
  bleed: { flexGrow: 0, marginHorizontal: -16 },
  chips: { gap: 6, paddingHorizontal: 16 },
  chip: {
    height: 34,
    paddingHorizontal: 13,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipCount: { opacity: 0.8 },
});

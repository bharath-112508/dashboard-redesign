import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import type { Tone } from '@/theme';
import { colors, motion, radii, useLoop } from '@/theme';

import { Icon, type IconName } from './Icon';
import { Txt } from './Txt';

export function Dot({ color, size = 8, radius }: { color: string; size?: number; /** default round */ radius?: number }) {
  return <View style={{ width: size, height: size, borderRadius: radius ?? size / 2, backgroundColor: color }} />;
}

export interface ChipProps {
  label: string;
  bg: string;
  fg: string;
  icon?: IconName;
  /** ring colour */
  ring?: string;
  style?: StyleProp<ViewStyle>;
}

/** Small soft chip (type chip, tag, "Billable", "Reported by …"). */
export function Chip({ label, bg, fg, icon, ring, style }: ChipProps) {
  return (
    <View style={[styles.chip, { backgroundColor: bg }, ring ? { borderWidth: 1, borderColor: ring } : null, style]}>
      {icon ? <Icon name={icon} size={12} color={fg} /> : null}
      <Txt v="chip" color={fg} numberOfLines={1}>
        {label}
      </Txt>
    </View>
  );
}

/** Ticket key chip, e.g. "PMT-11". */
export function KeyChip({ k, style }: { k: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.key, style]}>
      <Txt v="chip" color={colors.primaryInk}>
        {k}
      </Txt>
    </View>
  );
}

export interface StatusPillProps {
  label: string;
  tone: Pick<Tone, 'soft' | 'ink'> & { dot?: string };
  /** show the leading dot (default when tone.dot is set) */
  dot?: boolean;
  /** show a chevron (tappable status pill) */
  chevron?: boolean;
  size?: 'sm' | 'md';
}

/** Rounded status pill: project status, leave status, question status, client ticket status. */
export function StatusPill({ label, tone, dot, chevron, size = 'sm' }: StatusPillProps) {
  const showDot = dot ?? !!tone.dot;
  return (
    <View style={[styles.pill, size === 'md' && styles.pillMd, { backgroundColor: tone.soft }]}>
      {showDot && tone.dot ? <Dot color={tone.dot} size={7} /> : null}
      <Txt v={size === 'md' ? 'meta' : 'small'} w={700} color={tone.ink} numberOfLines={1}>
        {label}
      </Txt>
      {chevron ? <Icon name="chevron-down" size={14} color={tone.ink} /> : null}
    </View>
  );
}

/** Red "Critical" badge with a blinking dot (staff only). */
export function CriticalBadge() {
  const blink = useLoop(motion.critDot());
  return (
    <View style={styles.crit} accessible accessibilityLabel="Critical">
      <Animated.View style={[styles.critDot, blink]} />
      <Txt v="badge" color={colors.white}>
        Critical
      </Txt>
    </View>
  );
}

export interface CountBadgeProps {
  n: number;
  /** outline colour that separates it from the background (header: bg, tab: white) */
  outline?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

/** Red count badge (bell, tabs, More tiles). Pops in. Hidden when n is 0. */
export function CountBadge({ n, outline = colors.white, size = 19, style }: CountBadgeProps) {
  if (!n) return null;
  return (
    <Animated.View
      style={[
        styles.count,
        { minWidth: size, height: size, borderRadius: size / 2, borderColor: outline },
        motion.pop(),
        style,
      ]}
      accessible
      accessibilityLabel={`${n} new`}
    >
      <Txt v="badge" color={colors.white} style={{ fontSize: size <= 16 ? 9.5 : 11 }}>
        {String(n)}
      </Txt>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 7,
    alignSelf: 'flex-start',
  },
  key: {
    backgroundColor: colors.primarySoft,
    paddingHorizontal: 6,
    height: 21,
    borderRadius: radii.key,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    height: 24,
    borderRadius: radii.pill,
    alignSelf: 'flex-start',
  },
  pillMd: { height: 30, paddingHorizontal: 12 },
  crit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.danger,
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  critDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.white },
  count: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.danger,
    paddingHorizontal: 4,
    borderWidth: 2,
  },
});

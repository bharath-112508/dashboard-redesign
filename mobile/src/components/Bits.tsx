import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { PRIORITY_DOT, ROLE_COLOURS, ROLE_LABEL, TYPE_TAG } from '@/data/constants';
import type { Role, TicketPrio, TicketType } from '@/data/types';
import { colors, radii, tones, type Tone, type ToneName } from '@/theme';

import { Txt } from './Txt';

/** Round dot. */
export function Dot({ color, size = 8, style }: { color: string; size?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]} />;
}

export type BadgeTone = ToneName | Tone | { bg: string; ink: string; dot?: string };

function resolve(t: BadgeTone): { bg: string; ink: string; dot?: string } {
  if (typeof t === 'string') return { bg: tones[t].soft, ink: tones[t].ink, dot: tones[t].dot };
  if ('soft' in t) return { bg: t.soft, ink: t.ink, dot: t.dot };
  return t;
}

export interface BadgeProps {
  label: string;
  /** tone name ('green'), a Tone, or explicit colours; dot omitted when `dot` is false */
  tone?: BadgeTone;
  dot?: boolean;
  testID?: string;
}

/** Status badge: 22h, radius 7, 11.5/700 with a 6px dot (SPEC §6.2 rows). */
export function Badge({ label, tone = 'grey', dot = true, testID }: BadgeProps) {
  const c = resolve(tone);
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]} testID={testID}>
      {dot && c.dot ? <Dot color={c.dot} size={6} /> : null}
      <Txt v="small" w={700} color={c.ink} numberOfLines={1}>
        {label}
      </Txt>
    </View>
  );
}

/** Role pill in `RL` colours ("Client admin"). */
export function RoleBadge({ role, label }: { role: Role; label?: string }) {
  const c = ROLE_COLOURS[role];
  return <Badge label={label ?? ROLE_LABEL[role]} tone={{ bg: c.bg, ink: c.ink }} dot={false} />;
}

/** Priority dot `PRC` (8px). */
export function PriorityDot({ prio, size = 8 }: { prio: TicketPrio | string; size?: number }) {
  return <Dot color={PRIORITY_DOT[prio as TicketPrio] ?? colors.faint} size={size} />;
}

/** Ticket type tag `TYC` (Bug / Task / Story). */
export function TypeTag({ type }: { type: TicketType }) {
  const c = TYPE_TAG[type];
  return (
    <View style={[styles.tag, { backgroundColor: c.bg }]}>
      <Txt v="small" w={700} color={c.ink}>
        {type}
      </Txt>
    </View>
  );
}

/** Ticket key / version in monospace 11.5/700. */
export function MonoKey({ k, color = colors.ink3, size = 11.5 }: { k: string; color?: string; size?: number }) {
  return (
    <Txt v="key" color={color} style={{ fontSize: size }} numberOfLines={1}>
      {k}
    </Txt>
  );
}

/** Red count badge (tab bar): 17px, 2px white border, 10/800. Hidden at 0. */
export function CountBadge({ n, style }: { n: number; style?: StyleProp<ViewStyle> }) {
  if (!n) return null;
  return (
    <View style={[styles.count, style]} accessibilityLabel={`${n} new`}>
      <Txt v="tiny" w={800} color={colors.white} style={styles.countText}>
        {n > 99 ? '99+' : String(n)}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: radii.badge,
    alignSelf: 'flex-start',
  },
  tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, alignSelf: 'flex-start' },
  count: {
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.red,
    borderWidth: 2,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontSize: 10, lineHeight: 12 },
});

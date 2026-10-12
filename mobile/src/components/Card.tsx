import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, space } from '@/theme';

import { Icon, type IconName } from './Icon';
import { IconTile } from './IconTile';
import { Press } from './Press';
import { Txt } from './Txt';

export interface CardProps {
  children: ReactNode;
  /** ring colour (critical cards use colors.dangerRing) */
  ring?: string;
  pad?: number;
  radius?: number;
  bg?: string;
  style?: StyleProp<ViewStyle>;
  /** makes the card pressable */
  onPress?: () => void;
  /** required with onPress */
  label?: string;
  testID?: string;
}

/** White card, radius 20, 1px ring. Pressable cards scale to .98. */
export function Card({ children, ring = colors.line, pad = space.card.pad, radius = radii.card, bg = colors.surface, style, onPress, label, testID }: CardProps) {
  const s = [styles.card, { borderColor: ring, padding: pad, borderRadius: radius, backgroundColor: bg }, style];
  if (onPress) {
    return (
      <Press label={label ?? 'Open'} onPress={onPress} style={s} testID={testID}>
        {children}
      </Press>
    );
  }
  return (
    <View style={s} testID={testID}>
      {children}
    </View>
  );
}

/** Card that holds ListRows with dividers (no padding; rows pad themselves). */
export function ListCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, styles.listCard, style]}>{children}</View>;
}

export interface ListRowProps {
  title: string;
  sub?: string;
  icon?: IconName;
  iconBg?: string;
  iconFg?: string;
  /** custom leading element (avatar, logo) instead of the icon tile */
  leading?: ReactNode;
  /** custom trailing element; default is a chevron when pressable */
  trailing?: ReactNode;
  /** title colour (rust for Sign out) */
  titleColor?: string;
  onPress?: () => void;
  /** first row has no top divider */
  first?: boolean;
  /** highlighted background (unread) */
  bg?: string;
  chevron?: boolean;
  testID?: string;
}

/** Row inside a ListCard: icon tile, title, sub, and a chevron or trailing element. */
export function ListRow({ title, sub, icon, iconBg, iconFg, leading, trailing, titleColor = colors.ink, onPress, first, bg, chevron, testID }: ListRowProps) {
  const body = (
    <>
      {leading ?? (icon ? <IconTile icon={icon} bg={iconBg} fg={iconFg} size={34} radius={10} iconSize={18} /> : null)}
      <View style={styles.rowText}>
        <Txt v="rowTitle" color={titleColor} numberOfLines={2}>
          {title}
        </Txt>
        {sub ? (
          <Txt v="caption" color={colors.ink3} numberOfLines={2}>
            {sub}
          </Txt>
        ) : null}
      </View>
      {trailing ?? ((chevron ?? !!onPress) ? <Icon name="chevron-right" size={18} color={colors.muted} /> : null)}
    </>
  );
  const s = [styles.row, !first && styles.rowDivider, bg ? { backgroundColor: bg } : null];
  if (onPress) {
    return (
      <Press label={title} onPress={onPress} style={s} scale={1} testID={testID}>
        {body}
      </Press>
    );
  }
  return (
    <View style={s} testID={testID}>
      {body}
    </View>
  );
}

/** Uppercase eyebrow label (12/700, .08em). */
export function Eyebrow({ children, color = colors.ink3, style }: { children: string; color?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      <Txt v="eyebrow" color={color}>
        {children}
      </Txt>
    </View>
  );
}

export interface SectionProps {
  title: string;
  count?: number | string;
  link?: string;
  onLink?: () => void;
  /** 'section' (17/800, Home) or 'eyebrow' (uppercase) */
  variant?: 'section' | 'eyebrow';
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Section title with an optional count and a link on the right, then its content. */
export function Section({ title, count, link, onLink, variant = 'section', children, style }: SectionProps) {
  return (
    <View style={[styles.section, style]}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionTitle}>
          {variant === 'section' ? (
            <Txt v="section" accessibilityRole="header">
              {title}
            </Txt>
          ) : (
            <Txt v="eyebrow" color={colors.ink3} accessibilityRole="header">
              {title}
            </Txt>
          )}
          {count !== undefined ? (
            <Txt v="meta" color={colors.ink3}>
              {String(count)}
            </Txt>
          ) : null}
        </View>
        {link && onLink ? (
          <Press label={link} onPress={onLink} a11yRole="link">
            <Txt v="bodySm" w={700} color={colors.primaryInk}>
              {link}
            </Txt>
          </Press>
        ) : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card },
  listCard: { overflow: 'hidden', padding: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: space.card.rowV,
    paddingHorizontal: space.card.rowH,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.divider },
  rowText: { flex: 1, gap: 2 },
  section: { gap: 10 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
});

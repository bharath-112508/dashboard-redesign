import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, space } from '@/theme';

import { Press } from './Press';
import { Txt } from './Txt';

export interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** padding preset: none (rows), sm (6/14 lists), md (13/14), lg (14) */
  pad?: 'none' | 'sm' | 'md' | 'lg';
  /** background override (rows pass white) */
  bg?: string;
  testID?: string;
}

/** White card, radius 16, 1px ring #E4EAF0 (SPEC §6.2). Clips its rows. */
export function Card({ children, style, pad = 'none', bg = colors.surface, testID }: CardProps) {
  return (
    <View style={[styles.card, { backgroundColor: bg }, PAD[pad], style]} testID={testID}>
      {children}
    </View>
  );
}

const PAD: Record<NonNullable<CardProps['pad']>, ViewStyle> = {
  none: {},
  sm: { paddingVertical: 6, paddingHorizontal: 14 },
  md: { paddingVertical: 13, paddingHorizontal: 14 },
  lg: { padding: 14 },
};

export interface SectionHeadProps {
  title: string;
  sub?: string;
  /** soft action chip on the right ("Projects ›", "+ Add") */
  action?: string;
  onAction?: () => void;
  actionTestID?: string;
}

/** Section head: 15/800 title, 12.5 sub, soft action chip 30h (SPEC §4, §6.2). */
export function SectionHead({ title, sub, action, onAction, actionTestID }: SectionHeadProps) {
  return (
    <View style={styles.head}>
      <View style={styles.headText}>
        <Txt v="section" accessibilityRole="header">
          {title}
        </Txt>
        {sub ? (
          <Txt v="sub" color={colors.ink3} style={styles.headSub}>
            {sub}
          </Txt>
        ) : null}
      </View>
      {action && onAction ? (
        <Press label={action.replace(/[›+]/g, '').trim() || action} onPress={onAction} style={styles.action} testID={actionTestID}>
          <Txt v="sub" w={700} color={colors.primaryInk}>
            {action}
          </Txt>
        </Press>
      ) : null}
    </View>
  );
}

export interface BlockProps extends Partial<SectionHeadProps> {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A block with an optional section head above it (every v5 block may carry one). Use it
 * to wrap any block: `<Block title="Subtasks" sub="1 of 3 done"><Rows …/></Block>`.
 */
export function Block({ title, sub, action, onAction, actionTestID, children, style, testID }: BlockProps) {
  return (
    <View style={[styles.block, style]} testID={testID}>
      {title ? <SectionHead title={title} sub={sub} action={action} onAction={onAction} actionTestID={actionTestID} /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.card, borderWidth: 1, borderColor: colors.ringCard, overflow: 'hidden' },
  block: { gap: space.head, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 4 },
  headText: { flex: 1, minWidth: 0 },
  headSub: { marginTop: 1 },
  action: {
    height: 30,
    paddingHorizontal: 10,
    borderRadius: radii.chip,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

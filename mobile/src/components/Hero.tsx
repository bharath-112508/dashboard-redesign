import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radii, tones, type ToneName } from '@/theme';

import { Dot } from './Bits';
import { Icon } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

export type HeroVariant = 'white' | 'dark' | 'teal' | 'overdue' | 'plain';

const V: Record<HeroVariant, { bg: string; ink: string; ring?: string }> = {
  white: { bg: colors.surface, ink: colors.ink, ring: colors.ringCard },
  dark: { bg: colors.ink, ink: colors.white },
  teal: { bg: colors.maintHero, ink: colors.white },
  overdue: { bg: colors.overdueHero, ink: colors.ink, ring: colors.dangerRing },
  /** transparent (Sign in) */
  plain: { bg: colors.transparent, ink: colors.ink },
};

export interface HeroChip {
  text: string;
  dot?: string;
  bg?: string;
  color?: string;
}

export interface HeroProps {
  variant?: HeroVariant;
  /** 46px lead tile (radius 13): <ProjectTile size={46} radius={13}/>, <Avatar …/>, <BrandMark/> */
  lead?: ReactNode;
  eyebrow?: string;
  title: string;
  sub?: string;
  /** status pill button 32h with a dot; chevron when `onStatus` is set */
  status?: { label: string; tone?: ToneName; bg?: string; ink?: string; dot?: string };
  onStatus?: () => void;
  chips?: HeroChip[];
  /** progress bar 7h with a caption ("22% done") */
  bar?: { pct: number; color?: string; label: string };
  testID?: string;
}

/**
 * Hero block (SPEC §6.2): card r20 p16 with a lead tile, eyebrow 11/800 uppercase,
 * title 20/800, sub, status pill, chips 26h r8 and a progress bar. Variants: white,
 * dark (#1B2D45), teal (maintenance #123F3E), overdue (#FFF5F2).
 */
export function Hero({ variant = 'white', lead, eyebrow, title, sub, status, onStatus, chips, bar, testID }: HeroProps) {
  const v = V[variant];
  const onDark = variant === 'dark' || variant === 'teal';
  const st = status ? { bg: status.bg ?? tones[status.tone ?? 'grey'].soft, ink: status.ink ?? tones[status.tone ?? 'grey'].ink, dot: status.dot ?? tones[status.tone ?? 'grey'].dot } : null;
  const pill = st ? (
    <View style={[styles.status, { backgroundColor: st.bg }]}>
      <Dot color={st.dot} />
      <Txt v="label" w={700} color={st.ink} numberOfLines={1} style={styles.shrink}>
        {status!.label}
      </Txt>
      {onStatus ? <Icon name="chevron-down" size={14} color={st.ink} /> : null}
    </View>
  ) : null;
  return (
    <View style={[styles.hero, { backgroundColor: v.bg }, v.ring ? { borderWidth: 1, borderColor: v.ring } : null, variant === 'plain' && styles.plain]} testID={testID}>
      <View style={styles.top}>
        {lead}
        <View style={styles.text}>
          {eyebrow ? (
            <Txt v="eyebrow" color={v.ink} style={styles.eyebrow} numberOfLines={1}>
              {eyebrow}
            </Txt>
          ) : null}
          <Txt v="hero" color={v.ink} style={styles.title} accessibilityRole="header">
            {title}
          </Txt>
          {sub ? (
            <Txt v="label" w={400} color={v.ink} style={styles.sub}>
              {sub}
            </Txt>
          ) : null}
        </View>
      </View>
      {pill ? (
        <View style={styles.statusRow}>
          {onStatus ? (
            <Press label={`Status: ${status!.label}`} onPress={onStatus} testID={testID ? `${testID}-status` : 'hero-status'}>
              {pill}
            </Press>
          ) : (
            pill
          )}
        </View>
      ) : null}
      {chips?.length ? (
        <View style={styles.chips}>
          {chips.map((c, i) => (
            <View key={i} style={[styles.chip, { backgroundColor: c.bg ?? (onDark ? 'rgba(255,255,255,0.12)' : colors.track) }]}>
              {c.dot ? <Dot color={c.dot} size={7} /> : null}
              <Txt v="meta" w={600} color={c.color ?? (onDark ? colors.white : colors.ink2)} numberOfLines={1}>
                {c.text}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
      {bar ? (
        <View style={styles.barRow}>
          <View style={[styles.barTrack, { backgroundColor: onDark ? 'rgba(255,255,255,0.18)' : colors.track }]}>
            <View style={[styles.barFill, { width: `${Math.max(0, Math.min(100, bar.pct))}%`, backgroundColor: bar.color ?? colors.primary }]} />
          </View>
          <Txt v="sub" w={700} color={v.ink}>
            {bar.label}
          </Txt>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: radii.hero, padding: 16, gap: 12 },
  plain: { paddingHorizontal: 0 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, minWidth: 0 },
  eyebrow: { opacity: 0.85 },
  title: { marginTop: 1 },
  sub: { marginTop: 3, opacity: 0.9 },
  statusRow: { flexDirection: 'row' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 32, paddingHorizontal: 12, borderRadius: 99, maxWidth: '100%' },
  shrink: { flexShrink: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 26, paddingHorizontal: 10, borderRadius: radii.chip },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  barTrack: { flex: 1, height: 7, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4 },
});

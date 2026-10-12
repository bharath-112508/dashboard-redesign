import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { colors, motion, radii, type Anim } from '@/theme';

import { Card } from './Card';
import { Icon, type IconName } from './Icon';
import { IconTile } from './IconTile';
import { Press } from './Press';
import { Txt } from './Txt';

// ── Progress ────────────────────────────────────────────────────────────────

export interface ProgressBarProps {
  /** 0–100 */
  pct: number;
  color?: string;
  track?: string;
  height?: number;
  style?: StyleProp<ViewStyle>;
  label?: string;
}

/** Thin progress bar (default 4px, green on track). */
export function ProgressBar({ pct, color = colors.green, track = colors.divider2, height = 4, style, label }: ProgressBarProps) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <View
      style={[{ height, borderRadius: height, backgroundColor: track, overflow: 'hidden' }, style]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(w) }}
    >
      <View style={{ width: `${w}%`, height: '100%', backgroundColor: color, borderRadius: height }} />
    </View>
  );
}

export interface StackSegment {
  value: number;
  color: string;
}

export interface StackedBarProps {
  segments: StackSegment[];
  /** value that fills the whole bar (10 for a day, 40 for a week) */
  scale: number;
  height?: number;
  /** gap between segments (2 on the summary bar) */
  gap?: number;
  direction?: 'row' | 'column';
  track?: string;
  style?: StyleProp<ViewStyle>;
  label?: string;
}

/** Billable / non-billable / idle bar, horizontal or vertical (Home week card). */
export function StackedBar({ segments, scale, height = 8, gap = 0, direction = 'row', track = colors.track, style, label }: StackedBarProps) {
  const vertical = direction === 'column';
  return (
    <View
      style={[
        styles.stack,
        vertical ? { width: height, flexDirection: 'column-reverse', height: '100%' } : { height, flexDirection: 'row' },
        { gap, backgroundColor: track, borderRadius: height },
        style,
      ]}
      accessible={!!label}
      accessibilityLabel={label}
    >
      {segments
        .filter((s) => s.value > 0)
        .map((s, i) => {
          const pct = `${Math.min(100, (s.value / Math.max(scale, 0.0001)) * 100)}%` as const;
          return <View key={i} style={[{ backgroundColor: s.color }, vertical ? { height: pct, width: '100%' } : { width: pct, height: '100%' }]} />;
        })}
    </View>
  );
}

export interface ProgressRingProps {
  /** 0–100 */
  pct: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  children?: ReactNode;
  label?: string;
}

/** Circular progress (percent rings). */
export function ProgressRing({ pct, size = 44, stroke = 5, color = colors.green, track = colors.divider2, children, label }: ProgressRingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(p) }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${(c * p) / 100} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {children}
    </View>
  );
}

// ── Tiles ───────────────────────────────────────────────────────────────────

export interface KpiTileProps {
  label: string;
  value: string;
  sub: string;
  icon: IconName;
  /** accent colour; the icon square uses its soft colour */
  accent: string;
  accentSoft: string;
  /** value colour (red when there is something to act on) */
  valueColor?: string;
  /** looping icon animation (siren twinkle, alarm/bell ring) */
  iconAnim?: Anim | null;
  /** stagger index for the enter animation */
  index?: number;
  onPress?: () => void;
  testID?: string;
}

/** Home KPI tile: label, big value, sub; icon square top right. */
export function KpiTile({ label, value, sub, icon, accent, accentSoft, valueColor = colors.ink, iconAnim, index = 0, onPress, testID }: KpiTileProps) {
  return (
    <Animated.View style={[styles.kpiWrap, motion.fadeUp(index, 0.05, 0.06)]}>
      <Card onPress={onPress} label={`${label}: ${value}`} style={styles.kpi} testID={testID}>
        <View style={styles.kpiTop}>
          <Txt v="caption" w={600} color={colors.ink2} style={styles.kpiLabel}>
            {label}
          </Txt>
          <IconTile icon={icon} bg={accentSoft} fg={accent} size={36} radius={12} iconSize={18} anim={iconAnim} />
        </View>
        <Txt v="kpi" color={valueColor}>
          {value}
        </Txt>
        <Txt v="small" w={400} color={colors.ink3} numberOfLines={1}>
          {sub}
        </Txt>
      </Card>
    </Animated.View>
  );
}

export interface FactTileProps {
  label: string;
  /** lock glyph next to the label (Due, Estimate) */
  locked?: boolean;
  value?: string;
  valueColor?: string;
  sub?: string;
  subColor?: string;
  /** custom body instead of the value (avatar stack) */
  children?: ReactNode;
  /** small "+" action (Hours → Log time) */
  onPlus?: () => void;
  plusLabel?: string;
}

/** Ticket fact tile (radius 14, bg tile): eyebrow label, value, sub-label. */
export function FactTile({ label, locked, value, valueColor = colors.ink, sub, subColor = colors.ink3, children, onPlus, plusLabel }: FactTileProps) {
  return (
    <View style={styles.fact}>
      <View style={styles.factHead}>
        <Txt v="eyebrow" color={colors.ink2} style={{ fontSize: 11.5 }}>
          {label}
        </Txt>
        {locked ? <Icon name="lock" size={12} color={colors.faint} /> : null}
        <View style={{ flex: 1 }} />
        {onPlus ? (
          <Press label={plusLabel ?? `Add to ${label}`} onPress={onPlus} style={styles.factPlus} scale={0.94}>
            <Icon name="plus" size={16} color={colors.white} strokeWidth={2.6} />
          </Press>
        ) : null}
      </View>
      {children ?? (
        <Txt v="section" color={valueColor}>
          {value ?? ''}
        </Txt>
      )}
      {sub ? (
        <Txt v="bodySm" w={500} color={subColor} numberOfLines={1}>
          {sub}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { overflow: 'hidden' },
  kpiWrap: { flexBasis: '47%', flexGrow: 1, maxWidth: '48.7%' },
  kpi: { gap: 4, minHeight: 118 },
  kpiTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6, marginBottom: 2 },
  kpiLabel: { flex: 1, paddingTop: 2 },
  fact: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    paddingVertical: 12,
    paddingHorizontal: 13,
    gap: 4,
    borderWidth: 1,
    borderColor: colors.line,
  },
  factHead: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 22 },
  factPlus: {
    position: 'absolute',
    right: 0,
    top: -2,
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

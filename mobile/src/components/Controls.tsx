import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, control, radii, shadows } from '@/theme';

import { Dot } from './Chips';
import { Icon, type IconName } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

// ── SegmentedControl ─────────────────────────────────────────────────────────

export interface Segment<K extends string> {
  key: K;
  label: string;
  /** count shown after the label ("Open 6") */
  count?: number;
  icon?: IconName;
  /** colour dot before the label (Billable / Non-billable) */
  dot?: string;
}

export interface SegmentedControlProps<K extends string> {
  segments: Segment<K>[];
  value: K;
  onChange: (k: K) => void;
  /**
   * square: radius 12 / inner 10 (Tickets filter, sheets)
   * pill: fully rounded (Projects filter, Companies tabs)
   * icon: icon over label, 52 high, radius 18 (project view switcher)
   */
  variant?: 'square' | 'pill' | 'icon';
  /** accessible name of the group */
  label: string;
  style?: StyleProp<ViewStyle>;
}

/** Segmented control; the active segment is white with a shadow and weight 800. */
export function SegmentedControl<K extends string>({ segments, value, onChange, variant = 'square', label, style }: SegmentedControlProps<K>) {
  const outerR = variant === 'pill' ? radii.pill : variant === 'icon' ? radii.viewSwitch : 12;
  const innerR = variant === 'pill' ? radii.pill : variant === 'icon' ? 14 : radii.segmentInner;
  const h = variant === 'icon' ? 52 : control.segmented + 4;
  return (
    <View style={[styles.seg, { borderRadius: outerR, height: h }, style]} accessibilityRole="tablist" accessibilityLabel={label}>
      {segments.map((s) => {
        const on = s.key === value;
        const text = s.count !== undefined ? `${s.label} ${s.count}` : s.label;
        return (
          <Press
            key={s.key}
            label={text}
            a11yRole="tab"
            selected={on}
            onPress={() => onChange(s.key)}
            scale={0.97}
            style={[
              styles.segItem,
              { borderRadius: innerR },
              variant === 'icon' && styles.segIcon,
              on && styles.segOn,
            ]}
            testID={`seg-${s.key}`}
          >
            {variant === 'icon' && s.icon ? <Icon name={s.icon} size={18} color={on ? colors.primaryInk : colors.ink3} /> : null}
            <View style={styles.segLabel}>
              {s.dot ? <Dot color={s.dot} size={8} /> : null}
              <Txt v={variant === 'icon' ? 'small' : 'bodySm'} w={on ? 800 : 600} color={on ? colors.ink : colors.ink3} numberOfLines={1}>
                {s.label}
              </Txt>
              {s.count !== undefined ? (
                <Txt v={variant === 'icon' ? 'small' : 'bodySm'} w={on ? 800 : 600} color={on ? colors.ink3 : colors.muted}>
                  {String(s.count)}
                </Txt>
              ) : null}
            </View>
          </Press>
        );
      })}
    </View>
  );
}

// ── ChipRow ──────────────────────────────────────────────────────────────────

export interface ChipOption<K extends string> {
  key: K;
  label: string;
  icon?: IconName;
}

export interface ChipRowProps<K extends string> {
  options: ChipOption<K>[];
  value: K;
  onChange: (k: K) => void;
  label: string;
  /** horizontal scroll (filters) or wrap (sheet choices) */
  wrap?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Choice chips; the selected chip is dark ink with white text. */
export function ChipRow<K extends string>({ options, value, onChange, label, wrap, style }: ChipRowProps<K>) {
  const chips = options.map((o) => {
    const on = o.key === value;
    return (
      <Press
        key={o.key}
        label={o.label}
        a11yRole="radio"
        checked={on}
        onPress={() => onChange(o.key)}
        scale={0.97}
        style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
      >
        {o.icon ? <Icon name={o.icon} size={14} color={on ? colors.white : colors.ink} /> : null}
        <Txt v="meta" w={700} color={on ? colors.white : colors.ink} numberOfLines={1}>
          {o.label}
        </Txt>
      </Press>
    );
  });
  if (wrap) {
    return (
      <View style={[styles.chipWrap, style]} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {chips}
      </View>
    );
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipScroll}
      style={style}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      {chips}
    </ScrollView>
  );
}

// ── Toggle ───────────────────────────────────────────────────────────────────

export interface ToggleProps {
  value: boolean;
  onChange?: (v: boolean) => void;
  label: string;
  /** on colour: primary (profile) or green (settings, CI) */
  onColor?: string;
  /** read-only display (DevOps CI/CD switch) */
  readOnly?: boolean;
  size?: 'md' | 'sm';
}

/** Switch 46×28 (md) or 38×22 (sm). */
export function Toggle({ value, onChange, label, onColor = colors.primary, readOnly, size = 'md' }: ToggleProps) {
  const w = size === 'md' ? 46 : 38;
  const h = size === 'md' ? 28 : 22;
  const k = h - 6;
  const track = (
    <View style={[styles.toggle, { width: w, height: h, borderRadius: h / 2, backgroundColor: value ? onColor : colors.lineInput, justifyContent: value ? 'flex-end' : 'flex-start' }]}>
      <View style={[styles.knob, { width: k, height: k, borderRadius: k / 2 }]} />
    </View>
  );
  if (readOnly || !onChange) {
    return (
      <View accessible accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled: true }} aria-checked={value} aria-disabled>
        {track}
      </View>
    );
  }
  return (
    <Press label={label} a11yRole="switch" checked={value} onPress={() => onChange(!value)} scale={1}>
      {track}
    </Press>
  );
}

// ── Stepper ──────────────────────────────────────────────────────────────────

export interface StepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  label: string;
  /** shown under the value (e.g. "hours") */
  unit?: string;
  /** small inline variant (DevOps settings) */
  compact?: boolean;
  format?: (v: number) => string;
}

/** −/+ stepper: round 44px buttons and a 22/800 value (support plan hours). */
export function Stepper({ value, onChange, min = -Infinity, max = Infinity, label, unit, compact, format }: StepperProps) {
  const size = compact ? 30 : 44;
  const btn = (dir: -1 | 1) => {
    const next = value + dir;
    const disabled = next < min || next > max;
    return (
      <Press
        label={`${dir < 0 ? 'Decrease' : 'Increase'} ${label}`}
        onPress={() => onChange(next)}
        disabled={disabled}
        scale={0.94}
        style={[styles.stepBtn, { width: size, height: size, borderRadius: size / 2, opacity: disabled ? 0.4 : 1 }]}
      >
        <Icon name={dir < 0 ? 'minus' : 'plus'} size={compact ? 14 : 18} color={colors.ink} />
      </Press>
    );
  };
  return (
    <View style={styles.stepper} accessibilityLabel={label}>
      {btn(-1)}
      <View style={styles.stepValue}>
        <Txt v={compact ? 'bodySm' : 'titleTicket'} w={800}>
          {format ? format(value) : String(value)}
        </Txt>
        {unit ? (
          <Txt v="small" color={colors.ink3}>
            {unit}
          </Txt>
        ) : null}
      </View>
      {btn(1)}
    </View>
  );
}

const styles = StyleSheet.create({
  seg: { flexDirection: 'row', backgroundColor: colors.primarySoft, padding: 3, gap: 2 },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  segIcon: { gap: 2 },
  segOn: { backgroundColor: colors.surface, ...shadows.segmentActive },
  segLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: control.segmented,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipOff: { backgroundColor: colors.surface, borderColor: colors.line },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipScroll: { gap: 8, paddingRight: 8 },
  toggle: { padding: 3, flexDirection: 'row', alignItems: 'center' },
  knob: { backgroundColor: colors.white, ...shadows.knob },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepBtn: { backgroundColor: colors.stepper, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line },
  stepValue: { minWidth: 48, alignItems: 'center' },
});

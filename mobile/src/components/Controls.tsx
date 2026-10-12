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
   * pill: fully rounded, icon before the label (Projects filter, Companies tabs, Board/List)
   * icon: icon over label, 52 high, radius 18 (project view switcher)
   */
  variant?: 'square' | 'pill' | 'icon';
  /** accessible name of the group */
  label: string;
  style?: StyleProp<ViewStyle>;
  /** segment testID prefix, default "seg-" (testID = prefix + key) */
  testIDPrefix?: string;
}

/**
 * Segmented control (prototype): soft-blue track with 3px padding; the active segment is
 * white with a shadow and weight 800, inactive labels stay ink at 600, counts ink-3.
 * square: 36px segments, radius 10 (Tickets filter; sheets pass a taller style).
 * pill: 38px rounded segments, optional 15px icon before the label (Projects filter,
 * Companies tabs, Board/List). icon: 52px segments with the icon over an 11.5px label.
 */
export function SegmentedControl<K extends string>({
  segments,
  value,
  onChange,
  variant = 'square',
  label,
  style,
  testIDPrefix = 'seg-',
}: SegmentedControlProps<K>) {
  const outerR = variant === 'pill' ? radii.pill : variant === 'icon' ? radii.viewSwitch : 12;
  const innerR = variant === 'pill' ? radii.pill : variant === 'icon' ? 15 : radii.segmentInner;
  const h = variant === 'icon' ? 58 : variant === 'pill' ? 44 : 42;
  const anyIcon = segments.some((s) => s.icon);
  const v = variant === 'icon' ? 'chip' : variant === 'pill' ? (anyIcon ? 'bodySm' : 'meta') : 'body';
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
              variant === 'icon' ? styles.segIcon : styles.segRow,
              on && styles.segOn,
            ]}
            testID={`${testIDPrefix}${s.key}`}
          >
            {s.icon && variant !== 'square' ? <Icon name={s.icon} size={variant === 'icon' ? 17 : 15} color={colors.ink} /> : null}
            <View style={styles.segLabel}>
              {s.dot ? <Dot color={s.dot} size={8} radius={2} /> : null}
              <Txt v={v} w={on ? 800 : 600} color={colors.ink} numberOfLines={1} style={styles.segText}>
                {s.label}
              </Txt>
              {s.count !== undefined ? (
                <Txt v={v} w={600} color={colors.ink3}>
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

/**
 * Choice chips; the selected chip is dark ink with white text. Scrolling filter chips are
 * 36px / 13px; wrapped sheet choices are 38px / 13.5px with a 6px gap (prototype).
 */
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
        style={[styles.chip, wrap && styles.chipLg, on ? styles.chipOn : styles.chipOff]}
      >
        {o.icon ? <Icon name={o.icon} size={14} color={on ? colors.white : colors.ink} /> : null}
        <Txt v={wrap ? 'bodySm' : 'meta'} w={700} color={on ? colors.white : colors.ink} numberOfLines={1}>
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

/**
 * −/+ stepper (prototype): flat round buttons on the stepper grey, no ring; 44px with a
 * 22/800 value (support plan hours) or 32px with a 13.5/700 value (`compact`, settings).
 * At the limit the button stays visible: the icon turns faint and it stops responding.
 */
export function Stepper({ value, onChange, min = -Infinity, max = Infinity, label, unit, compact, format }: StepperProps) {
  const size = compact ? 32 : 44;
  const btn = (dir: -1 | 1) => {
    const next = value + dir;
    const disabled = next < min || next > max;
    return (
      <Press
        label={`${dir < 0 ? 'Decrease' : 'Increase'} ${label}`}
        onPress={() => onChange(next)}
        disabled={disabled}
        scale={0.94}
        style={[styles.stepBtn, { width: size, height: size, borderRadius: size / 2 }]}
      >
        <Icon name={dir < 0 ? 'minus' : 'plus'} size={compact ? 15 : 18} color={disabled ? colors.faint : colors.ink} />
      </Press>
    );
  };
  return (
    <View style={styles.stepper} accessibilityLabel={label}>
      {btn(-1)}
      <View style={[styles.stepValue, compact && { minWidth: 84 }]}>
        <Txt v={compact ? 'bodySm' : 'titleTicket'} w={compact ? 700 : 800} color={compact ? colors.ink2 : colors.ink}>
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
  segItem: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center' },
  segRow: { flexDirection: 'row', gap: 6 },
  segIcon: { gap: 4, paddingHorizontal: 2 },
  segText: { flexShrink: 1 },
  segOn: { backgroundColor: colors.surface, ...shadows.segmentActive },
  segLabel: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, maxWidth: '100%' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: control.segmented,
    paddingHorizontal: 13, // 14 in the prototype, minus the 1px ring (a box-shadow there)
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  chipLg: { height: 38 },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipOff: { backgroundColor: colors.surface, borderColor: colors.line },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chipScroll: { gap: 8, paddingRight: 8 },
  toggle: { padding: 3, flexDirection: 'row', alignItems: 'center' },
  knob: { backgroundColor: colors.white, ...shadows.knob },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: { backgroundColor: colors.stepper, alignItems: 'center', justifyContent: 'center' },
  stepValue: { minWidth: 60, alignItems: 'center' },
});

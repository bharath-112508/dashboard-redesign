import { Children, isValidElement, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radii } from '@/theme';

import { Badge, Dot, MonoKey, type BadgeProps } from './Bits';
import { Card } from './Card';
import { EmptyBlock } from './EmptyBlock';
import { Icon, type IconName } from './Icon';
import { Press } from './Press';
import { Toggle } from './Toggle';
import { Txt } from './Txt';

export interface RowMeta {
  icon?: IconName;
  text: string;
  color?: string;
  /** 700 for emphasis (unread, overdue) */
  bold?: boolean;
  /** mini progress bar 34x5 after the text (0–100) */
  bar?: number;
}

export interface RowBar {
  /** 0–100; above 100 shows the red overflow segment */
  pct: number;
  color?: string;
  label?: string;
  labelColor?: string;
}

export interface RowProps {
  title: string;
  /** a11y label (defaults to the title) */
  label?: string;
  sub?: string;
  /** let the sub wrap (default one line) */
  subWrap?: boolean;
  subColor?: string;
  titleColor?: string;
  titleWeight?: 600 | 700 | 800;
  /** strike-through title (done subtasks) */
  strike?: boolean;
  /** leading tile: <Avatar/>, <IconTile/>, <ProjectTile/>, <CompanyTile/>, <TextTile/> */
  lead?: ReactNode;
  /** left check box 26 r8 (subtasks) */
  check?: { on: boolean; onToggle?: () => void; label: string };
  /** priority dot colour (or a priority name resolved by the caller) */
  dot?: string;
  /** mono key before the title */
  monoKey?: string;
  /** inline progress bar under the title */
  bar?: RowBar;
  meta?: (RowMeta | null | false | undefined)[];
  badge?: BadgeProps;
  /** right-hand text */
  right?: string;
  rightColor?: string;
  rightWeight?: 600 | 700 | 800;
  /** toggle 44x26 on the right (the row press toggles it) */
  toggle?: boolean;
  /** right check box 24 r7 (pick lists) */
  picked?: boolean;
  /** chevron (default: when pressable and not a toggle/pick) */
  chevron?: boolean;
  bg?: string;
  /** 0.6 for inactive rows */
  opacity?: number;
  onPress?: () => void;
  testID?: string;
}

/**
 * The generic v5 list row (SPEC §6.2 "Rows"): padding 12/14, gap 12, every slot of the
 * prototype's `R()` row. Put rows in `<Rows>` (card with dividers).
 */
export function Row(p: RowProps) {
  const meta = (p.meta ?? []).filter(Boolean) as RowMeta[];
  const chev = p.chevron ?? (!!p.onPress && p.toggle === undefined && p.picked === undefined);
  const over = p.bar && p.bar.pct > 100;
  const inner = (
    <>
      {p.check ? (
        <Press
          label={p.check.label}
          a11yRole="checkbox"
          checked={p.check.on}
          onPress={p.check.onToggle}
          disabled={!p.check.onToggle}
          style={[styles.checkL, p.check.on ? styles.checkOn : styles.checkOff]}
          testID={p.testID ? `${p.testID}-check` : undefined}
        >
          {p.check.on ? <Icon name="check" size={15} color={colors.white} strokeWidth={3} /> : null}
        </Press>
      ) : null}
      {p.lead}
      <View style={styles.main}>
        <View style={styles.titleLine}>
          {p.dot ? <Dot color={p.dot} /> : null}
          {p.monoKey ? <MonoKey k={p.monoKey} /> : null}
          <Txt
            v="rowTitle"
            w={p.titleWeight}
            color={p.titleColor ?? colors.ink}
            numberOfLines={1}
            style={[styles.title, p.strike && styles.strike]}
          >
            {p.title}
          </Txt>
        </View>
        {p.sub ? (
          <Txt v="sub" color={p.subColor ?? colors.ink3} numberOfLines={p.subWrap ? undefined : 1} style={styles.sub}>
            {p.sub}
          </Txt>
        ) : null}
        {p.bar ? (
          <View style={styles.barLine}>
            <View style={styles.barTrack}>
              <View style={{ height: '100%', width: `${Math.min(100, over ? (100 / p.bar.pct) * 100 : p.bar.pct)}%`, backgroundColor: p.bar.color ?? colors.primary }} />
              {over ? <View style={{ height: '100%', width: `${100 - (100 / p.bar.pct) * 100}%`, backgroundColor: colors.red }} /> : null}
            </View>
            {p.bar.label ? (
              <Txt v="small" w={700} color={p.bar.labelColor ?? colors.ink3}>
                {p.bar.label}
              </Txt>
            ) : null}
          </View>
        ) : null}
        {meta.length ? (
          <View style={styles.metaLine}>
            {meta.map((m, i) => (
              <View key={i} style={styles.meta}>
                {m.icon ? <Icon name={m.icon} size={13} color={m.color ?? colors.ink3} /> : null}
                <Txt v="meta" w={m.bold ? 700 : 500} color={m.color ?? colors.ink3}>
                  {m.text}
                </Txt>
                {m.bar !== undefined ? (
                  <View style={styles.miniTrack}>
                    <View style={[styles.miniFill, { width: `${Math.max(0, Math.min(100, m.bar))}%` }]} />
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
      </View>
      {p.badge || p.right ? (
        <View style={styles.rightCol}>
          {p.badge ? <Badge {...p.badge} /> : null}
          {p.right ? (
            <Txt v="sub" w={p.rightWeight ?? 600} color={p.rightColor ?? colors.ink3} numberOfLines={1}>
              {p.right}
            </Txt>
          ) : null}
        </View>
      ) : null}
      {p.toggle !== undefined ? <Toggle on={p.toggle} /> : null}
      {p.picked !== undefined ? (
        <View style={[styles.pick, p.picked ? styles.checkOn : styles.checkOff]}>
          {p.picked ? <Icon name="check" size={14} color={colors.white} strokeWidth={3} /> : null}
        </View>
      ) : null}
      {chev ? <Icon name="chevron-right" size={17} color={colors.faint} /> : null}
    </>
  );
  const style = [styles.row, { backgroundColor: p.bg ?? colors.surface, opacity: p.opacity ?? 1 }];
  if (!p.onPress) {
    return (
      <View style={style} testID={p.testID}>
        {inner}
      </View>
    );
  }
  const role = p.toggle !== undefined ? 'switch' : p.picked !== undefined ? 'radio' : 'button';
  return (
    <Press
      label={p.label ?? p.title}
      a11yRole={role}
      checked={p.toggle ?? p.picked}
      onPress={p.onPress}
      style={style}
      testID={p.testID}
    >
      {inner}
    </Press>
  );
}

export interface RowsProps {
  children?: ReactNode;
  /** shown as an EmptyBlock when there are no rows */
  empty?: string;
  testID?: string;
}

/** A card of rows with 1px dividers (#EEF3FB). */
export function Rows({ children, empty, testID }: RowsProps) {
  const items = Children.toArray(children).filter(isValidElement);
  if (!items.length) return empty ? <EmptyBlock text={empty} testID={testID ? `${testID}-empty` : undefined} /> : null;
  return (
    <Card testID={testID}>
      {items.map((c, i) => (
        <View key={c.key ?? i} style={i ? styles.divider : null}>
          {c}
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  main: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  title: { flexShrink: 1, minWidth: 0 },
  strike: { textDecorationLine: 'line-through' },
  sub: { marginTop: 2 },
  barLine: { marginTop: 7, flexDirection: 'row', alignItems: 'center', gap: 8 },
  barTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.track, overflow: 'hidden', flexDirection: 'row' },
  metaLine: { marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  miniTrack: { width: 34, height: 5, borderRadius: 3, backgroundColor: colors.ringCard, overflow: 'hidden' },
  miniFill: { height: '100%', backgroundColor: colors.green },
  rightCol: { alignItems: 'flex-end', gap: 4, flexShrink: 0 },
  checkL: { width: 26, height: 26, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  pick: { width: 24, height: 24, borderRadius: radii.badge, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  checkOn: { borderColor: colors.primary, backgroundColor: colors.primary },
  checkOff: { borderColor: colors.lineInput, backgroundColor: colors.surface },
});

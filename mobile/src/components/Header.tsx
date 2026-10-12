import { StyleSheet, View } from 'react-native';

import { back } from '@/nav/routes';
import { colors, radii } from '@/theme';

import { Icon, type IconName } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

export interface HeaderAction {
  icon: IconName;
  /** a11y label ("Search", "New project") */
  label: string;
  onPress: () => void;
  testID?: string;
}

export interface HeaderProps {
  title: string;
  sub?: string;
  /** 0–3 icon buttons (40x40, r12, white with ring) */
  actions?: HeaderAction[];
  /** tab root: 26/800 title, no back button; pushed: 19/800 with Back */
  root?: boolean;
  /** custom back (default: pop) */
  onBack?: () => void;
}

/** Header (SPEC §1.1): padding 4/14/10, gap 8; Back 40x40 r12; title 26 root / 19 pushed; sub 12.5. */
export function Header({ title, sub, actions = [], root, onBack = back }: HeaderProps) {
  return (
    <View style={styles.row}>
      {!root ? (
        <Press label="Back" onPress={onBack} style={styles.btn} testID="header-back">
          <Icon name="chevron-left" size={20} color={colors.ink} />
        </Press>
      ) : null}
      <View style={styles.text}>
        <Txt v={root ? 'titleRoot' : 'title'} numberOfLines={1} accessibilityRole="header" testID="header-title">
          {title}
        </Txt>
        {sub ? (
          <Txt v="sub" color={colors.ink3} numberOfLines={1} testID="header-sub">
            {sub}
          </Txt>
        ) : null}
      </View>
      {actions.slice(0, 3).map((a) => (
        <Press key={a.label} label={a.label} onPress={a.onPress} style={styles.btn} testID={a.testID ?? `header-${a.icon}`}>
          <Icon name={a.icon} size={18} color={colors.ink} />
        </Press>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4, paddingHorizontal: 14, paddingBottom: 10 },
  text: { flex: 1, minWidth: 0 },
  btn: {
    width: 40,
    height: 40,
    borderRadius: radii.input,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.ringCard,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

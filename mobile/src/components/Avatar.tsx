import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { FACES } from '@/data/media/faces';
import { avatarOf } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { colors } from '@/theme';

import { Txt } from './Txt';

export interface AvatarProps {
  name: string;
  /** square size, default 40 */
  size?: number;
  /** corner radius, default ~size × .28; pass size / 2 for round */
  radius?: number;
  /** always show initials (e.g. client people) */
  initialsOnly?: boolean;
  /** override the background for initials (navy for contacts) */
  bg?: string;
  /** white ring (avatar stacks) */
  ring?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A person's photo, or initials on their colour. Client viewers never see staff photos,
 * and client people always render as initials (SPEC §2.1).
 */
export function Avatar({ name, size = 40, radius, initialsOnly, bg, ring, style }: AvatarProps) {
  const info = useAppState((s) => avatarOf(s, name));
  const r = radius ?? Math.round(size * 0.28);
  const face = !initialsOnly && info.face ? FACES[info.face] : null;
  const box = {
    width: size,
    height: size,
    borderRadius: r,
    backgroundColor: face ? colors.track : (bg ?? info.color),
  };
  return (
    <View
      style={[styles.box, box, ring && styles.ring, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
    >
      {face ? (
        <Image source={face} style={{ width: size, height: size }} resizeMode="cover" />
      ) : (
        <Txt v="small" w={800} color={colors.white} style={{ fontSize: Math.max(9, Math.round(size * 0.36)) }}>
          {info.initials}
        </Txt>
      )}
    </View>
  );
}

export interface AvatarStackProps {
  names: string[];
  size?: number;
  /** overlap in px (prototype −5) */
  overlap?: number;
  max?: number;
}

/** Overlapping avatars with a white ring (ticket cards, facts). */
export function AvatarStack({ names, size = 24, overlap = 5, max = 4 }: AvatarStackProps) {
  return (
    <View style={styles.stack} accessible accessibilityLabel={names.join(', ')}>
      {names.slice(0, max).map((n, i) => (
        <Avatar
          key={n}
          name={n}
          size={size}
          radius={Math.round(size / 4)}
          ring
          style={i ? { marginLeft: -overlap } : undefined}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  ring: { borderWidth: 2, borderColor: colors.white },
  stack: { flexDirection: 'row', alignItems: 'center' },
});

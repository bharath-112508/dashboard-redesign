import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { colors, useLoop, type Anim } from '@/theme';

import { Icon, type IconName } from './Icon';

export interface IconTileProps {
  icon: IconName;
  bg?: string;
  fg?: string;
  /** square size: 34 (rows), 36 (KPI), 40 (lists), 42 (More tiles) */
  size?: number;
  radius?: number;
  iconSize?: number;
  /** looping icon animation (bell, twinkle, drift); dropped with reduced motion */
  anim?: Anim | null;
  style?: StyleProp<ViewStyle>;
}

/** Rounded square with a centred icon on a soft colour. */
export function IconTile({ icon, bg = colors.primarySoft, fg = colors.primaryInk, size = 40, radius, iconSize, anim, style }: IconTileProps) {
  const a = useLoop(anim);
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: radius ?? Math.round(size * 0.34), backgroundColor: bg, alignItems: 'center', justifyContent: 'center' },
        style,
      ]}
    >
      <Animated.View style={a}>
        <Icon name={icon} size={iconSize ?? Math.round(size * 0.5)} color={fg} />
      </Animated.View>
    </View>
  );
}

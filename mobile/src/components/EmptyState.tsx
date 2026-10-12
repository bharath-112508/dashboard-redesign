import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { colors, motion, useLoop } from '@/theme';

import { Card } from './Card';
import { Icon, type IconName } from './Icon';
import { Txt } from './Txt';

export interface EmptyStateProps {
  icon?: IconName;
  text: string;
  /** render without the card (inside an existing card) */
  bare?: boolean;
}

/** Empty state: bobbing icon and a short line ("Nothing here."). */
export function EmptyState({ icon = 'inbox', text, bare }: EmptyStateProps) {
  const bob = useLoop(motion.bob());
  const body = (
    <View style={styles.body}>
      <Animated.View style={bob}>
        <Icon name={icon} size={28} color={colors.faint} />
      </Animated.View>
      <Txt v="bodySm" color={colors.ink3} align="center">
        {text}
      </Txt>
    </View>
  );
  return bare ? body : <Card>{body}</Card>;
}

/** Inline empty text inside a card ("Nothing urgent."). */
export function EmptyText({ text }: { text: string }) {
  return (
    <View style={styles.inline}>
      <Txt v="bodySm" color={colors.ink3}>
        {text}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: 'center', gap: 8, paddingVertical: 18 },
  inline: { paddingVertical: 14, paddingHorizontal: 14 },
});

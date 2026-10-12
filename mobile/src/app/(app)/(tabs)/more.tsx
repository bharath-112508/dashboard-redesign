import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Card, Eyebrow, ListCard, ListRow } from '@/components/Card';
import { CountBadge } from '@/components/Chips';
import { Icon } from '@/components/Icon';
import { IconTile } from '@/components/IconTile';
import { Screen } from '@/components/Screen';
import { Txt } from '@/components/Txt';
import { me } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { moreTiles } from '@/nav/moreTiles';
import { href, hrefForKey, push } from '@/nav/routes';
import { colors, motion } from '@/theme';

/**
 * S-MORE More (tab root). P0 ships a working version so sign out, switch account and
 * every role's tiles can be tested; P2 owns and may replace this file
 * (src/app/(app)/(tabs)/more.tsx).
 */
export default function MoreTab() {
  const person = useAppState(me);
  const tiles = useAppState(moreTiles);
  const { signOut, switchAccount } = useActions();
  if (!person?.role) return null;
  const role = person.role;
  return (
    <Screen title="More" header="large" gap={18} testID="screen-more">
      <Card onPress={() => push(href.me())} label="View profile" radius={24} style={styles.profile} testID="more-profile">
        <Avatar name={person.name} size={52} radius={16} bg={person.client ? colors.ink : undefined} />
        <View style={styles.flex}>
          <Txt v="section">{person.name}</Txt>
          <Txt v="caption" color={colors.ink3} numberOfLines={1}>{`${person.title} · View profile`}</Txt>
        </View>
        <Icon name="chevron-right" size={18} color={colors.muted} />
      </Card>

      <View style={styles.block}>
        <Eyebrow>Everything else</Eyebrow>
        <View style={styles.grid}>
          {tiles.map((t, i) => (
            <Animated.View key={t.key} style={[styles.tileWrap, motion.fadeUp(i, 0.08, 0.05)]}>
              <Card
                onPress={() => router.push(hrefForKey(t.key, role))}
                label={`${t.label}, ${t.sub}`}
                style={styles.tile}
                testID={`more-tile-${t.key}`}
              >
                <View style={styles.tileTop}>
                  <IconTile icon={t.icon} bg={t.bg} fg={t.fg} size={42} radius={14} iconSize={20} />
                  <CountBadge n={t.badge} size={19} />
                </View>
                <Txt v="rowTitle" numberOfLines={1}>
                  {t.label}
                </Txt>
                <Txt v="caption" color={colors.ink3} numberOfLines={1}>
                  {t.sub}
                </Txt>
              </Card>
            </Animated.View>
          ))}
        </View>
      </View>

      <View style={styles.block}>
        <Eyebrow>Account</Eyebrow>
        <ListCard>
          <ListRow first title="Switch account" icon="repeat-2" iconBg={colors.track} iconFg={colors.ink2} onPress={switchAccount} testID="more-switch-account" />
          <ListRow
            title="Sign out"
            icon="log-out"
            iconBg={colors.destructiveBg}
            iconFg={colors.destructiveInk}
            titleColor={colors.destructiveInk}
            onPress={signOut}
            chevron={false}
            testID="more-sign-out"
          />
        </ListCard>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  block: { gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tileWrap: { flexBasis: '47%', flexGrow: 1, maxWidth: '48.7%' },
  tile: { gap: 4, minHeight: 118 },
  tileTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
});

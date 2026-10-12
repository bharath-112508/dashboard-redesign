import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { me, questionsNeedingClient } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { goTab } from '@/nav/routes';
import { tabsFor, type TabKey } from '@/nav/tabs';
import { useShellRoute } from '@/nav/useActiveTab';
import { colors, motion, pressScale, shadows, useLoop } from '@/theme';

import { CountBadge } from './Chips';
import { Icon } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

/** Routes that hide the tab bar (they show the composer instead). */
const NO_TAB_BAR = ['ticket/[id]', 'question/[id]'];

/**
 * Floating tab bar for the signed-in role (SPEC §1.4). Rendered once by the (app) layout
 * above every screen; the highlighted tab is the one that owns the current stack.
 */
export function TabBar() {
  const role = useAppState((s) => me(s)?.role ?? null);
  const qBadge = useAppState((s) => questionsNeedingClient(s).length);
  const { tab, top } = useShellRoute();
  const insets = useSafeAreaInsets();
  if (!role) return null;
  if (NO_TAB_BAR.includes(top) || top.startsWith('sheet/')) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { paddingBottom: insets.bottom > 0 ? insets.bottom : 24 }]}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(246,249,252,0)', colors.bg]}
        locations={[0, 0.35]}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.bar} accessibilityRole="tablist" testID="tab-bar">
        {tabsFor(role).map((t) => (
          <TabItem
            key={t.key}
            k={t.key}
            label={t.label}
            icon={t.icon}
            active={t.key === tab}
            badge={t.key === 'questions' && t.key !== tab ? qBadge : 0}
          />
        ))}
      </View>
    </View>
  );
}

function TabItem({ k, label, icon, active, badge }: { k: TabKey; label: string; icon: Parameters<typeof Icon>[0]['name']; active: boolean; badge: number }) {
  const pop = useLoop(active ? motion.pop(0.35) : null);
  const color = active ? colors.primaryInk : colors.muted;
  return (
    <Press
      label={label}
      a11yRole="tab"
      selected={active}
      onPress={() => goTab(k)}
      scale={pressScale.tab}
      style={styles.item}
      testID={`tab-${k}`}
    >
      <View style={[styles.pill, active && styles.pillOn]}>
        <Animated.View key={active ? 'on' : 'off'} style={pop}>
          <Icon name={icon} size={20} color={color} strokeWidth={active ? 2.2 : 2} />
        </Animated.View>
        <CountBadge n={badge} size={16} style={styles.badge} />
      </View>
      <Txt v="tabLabel" w={active ? 700 : 600} color={color} numberOfLines={1}>
        {label}
      </Txt>
    </Press>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 8, paddingHorizontal: 12 },
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 24,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderWidth: 1,
    borderColor: colors.lineTabbar,
    ...shadows.tabBar,
  },
  item: { flex: 1, height: 54, alignItems: 'center', justifyContent: 'center', gap: 2 },
  pill: { width: 52, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: colors.primarySoft },
  badge: { position: 'absolute', top: -4, right: 6 },
});

import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { me, openQuestions, unreadTotal } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { goTab } from '@/nav/routes';
import { deepLinkOwner, tabsFor, type TabKey } from '@/nav/tabs';
import { useShellRoute } from '@/nav/useActiveTab';
import { colors, radii, shadows, tabBar } from '@/theme';

import { CountBadge } from './Bits';
import { Icon, type IconName } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

/**
 * Floating tab bar (SPEC §1.1, §1.3, D-CMP-4): left/right 12, bottom 22, 66 high, radius
 * 24, white with a ring and shadow, equal columns. Shown on every signed-in screen; a URL
 * sheet covers it. The highlighted tab owns the stack; on a deep-linked screen it is the tab
 * that owns that screen (`deepLinkOwner`). Badges: Tickets = unread on my tickets (staff), Questions = open
 * questions (clients).
 */
export function TabBar() {
  const role = useAppState((s) => me(s)?.role ?? null);
  const unread = useAppState(unreadTotal);
  const questions = useAppState((s) => openQuestions(s).length);
  const { tab: stackTab, top, deepLink } = useShellRoute();
  const insets = useSafeAreaInsets();
  if (!role || top.startsWith('sheet/')) return null;
  // a deep-linked screen highlights the tab that owns it, not Home
  const tab = deepLink ? deepLinkOwner(deepLink, role) : stackTab;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: Math.max(tabBar.bottom, insets.bottom) }]}>
      <View style={styles.bar} accessibilityRole="tablist" testID="tab-bar">
        {tabsFor(role).map((t) => (
          <TabItem
            key={t.key}
            k={t.key}
            label={t.label}
            icon={t.icon}
            active={t.key === tab}
            badge={t.key === 'tickets' ? unread : t.key === 'questions' ? questions : 0}
          />
        ))}
      </View>
    </View>
  );
}

function TabItem({ k, label, icon, active, badge }: { k: TabKey; label: string; icon: IconName; active: boolean; badge: number }) {
  return (
    <Press label={label} a11yRole="tab" selected={active} onPress={() => goTab(k)} style={styles.item} testID={`tab-${k}`} flat>
      <View style={[styles.pill, active && styles.pillOn]}>
        <Icon name={icon} size={20} color={active ? colors.white : colors.ink3} />
        <CountBadge n={badge} style={styles.badge} />
      </View>
      <Txt v="tab" w={active ? 800 : 600} color={active ? colors.primaryInk : colors.ink3} numberOfLines={1}>
        {label}
      </Txt>
    </Press>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: tabBar.side, right: tabBar.side },
  bar: {
    height: tabBar.height,
    flexDirection: 'row',
    padding: 6,
    borderRadius: radii.tabBar,
    backgroundColor: colors.surface,
    ...shadows.tabBar,
  },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  pill: { width: 54, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: colors.primary },
  badge: { position: 'absolute', top: -3, right: 6 },
});
